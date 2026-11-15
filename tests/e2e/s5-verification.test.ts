/**
 * S5 acceptance (plan §10.2 S5), real x86-64 ELF fixtures run in Docker:
 *  1. intcalc naive replacement -> `difference` with byte/line/column location.
 *  2. The same replacement under a tolerance policy -> `match`, normalized, raw_equal=false, with a trace; an overflow case stays `difference`.
 *  3. rand reference is captured `deterministic=false`; it never matches without an explicit rule.
 *  S6: the tolerance and ruled runs are exported, unzipped, integrity-checked and replayed on the host, with `--docker`, and (intcalc) with `--original`;
 *      replay outcomes must equal the stored summary, and the same binding rebuilt after the run goes stale keeps an identical SHA256SUMS.
 * Substitutes: PGlite, FsBlobStore, Docker runc (not gVisor), unsandboxed tsc build. Skips when Docker or fixtures are missing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import type { Ctx } from '../../server/domain/ctx';
import { completeUpload, createUpload, recordExecutionConsent, sealSourceRevision } from '../../server/domain/sources';
import { createPolicy, createTestCase, requestCapture, requestProbe } from '../../server/domain/cases';
import { createExport } from '../../server/domain/exports';
import { buildExport } from '../../workers/export/build';
import { createScopeRevision, decideScope, putScopeDraft } from '../../server/domain/projects';
import { createModuleRevision } from '../../server/domain/modules';
import { createVerificationRun } from '../../server/domain/verification';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { NODE_IMAGE } from '../../workers/export/build';
import { drain } from '../../workers/main';
import { DockerOriginalRunner, DockerReplacementRunner } from '../../workers/execution/runners';
import { localBuild } from '../../workers/build/local';
import type { WorkerEnv } from '../../workers/runtime';

const root = join(__dirname, '../..');
const docker = [process.env.DOCKER_BIN, `${process.env.HOME}/.docker/bin/docker`, '/usr/local/bin/docker', 'docker'].filter(Boolean).find((d) => { try { execFileSync(d!, ['info'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } });
const skip = !docker || !existsSync(join(root, 'fixtures/bin/intcalc')) || !existsSync(join(root, 'fixtures/bin/rand'));
if (skip) console.warn(`[s5-e2e] SKIPPED: docker=${docker ?? 'unavailable'} fixtures=${skip ? 'missing (make -C fixtures)' : 'present'}`);
if (docker) process.env.PATH = `${dirname(docker)}:${process.env.PATH}`;
const IMAGE = 'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NAIVE = [{ path: 'src/index.ts', content: readFileSync(join(root, 'fixtures/replacements/intcalc-naive/src/index.ts'), 'utf8') }];
const RAND_MODULE = [{ path: 'src/index.ts', content: "export async function run(): Promise<{ stdout?: string; exitCode?: number }> { return { stdout: 'sample=00000000\\n' }; }\n" }];

// intcalc cases. `round` ones differ from the naive module only in the 2nd decimal; `overflow` differs hugely.
const INTCALC: { name: string; argv: string[] }[] = [
  { name: 'exact third', argv: ['3', '3'] },
  { name: 'negative', argv: ['-10', '4'] },
  { name: 'round up', argv: ['1', '1'] },
  { name: 'round up two', argv: ['2', '0'] },
  { name: 'overflow', argv: ['2147483647', '1'] },
  { name: 'bad args', argv: ['1'] },
];

describe.skipIf(skip)('S5: verification depth (real ELF in Docker)', () => {
  let db: Db, c: Ctx, env: WorkerEnv, origEnv: string, replEnv: string;
  const org = uuidv7(), user = uuidv7();

  async function importProject(name: string, bin: string) {
    const project = uuidv7();
    await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,$3)", [project, org, name]);
    const bytes = readFileSync(join(root, 'fixtures/bin', bin));
    const u = await createUpload(c, project, { filename: bin, size: bytes.length, sha256: sha(bytes) });
    const f = u.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes);
    await completeUpload(c, u.upload_id);
    const source = (await sealSourceRevision(c, project, { artifacts: [{ upload_id: u.upload_id, path: `bin/${bin}`, role: 'primary_executable' }], notes: '', objectives: 'same output' })).id;
    await drain(env, ['inspect']);
    await recordExecutionConsent(c, source, 'I am authorized to run this executable in an isolated sandbox');
    return { project, source };
  }
  async function approveScope(project: string) {
    await putScopeDraft(c.db, org, project, { workflow: { name: 'tool', invocation: { argv_template: [], stdin: 'none' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'b1', statement: 'Behaves like the original', basis: 'observed' }] }, null, user);
    const scope = await createScopeRevision(c.db, org, project, 1, user);
    await decideScope(c.db, org, project, scope.id, 'approved', scope.document_sha256, user);
    return scope.id;
  }
  async function addModule(project: string, scope: string, files: { path: string; content: string }[]) {
    const m = await createModuleRevision(c, project, { scope_revision_id: scope, origin: 'customer_upload', files });
    await drain(env, ['build']);
    expect((await db.query<{ status: string }>('SELECT status FROM build_results WHERE module_revision_id=$1', [m.id]))[0].status).toBe('succeeded');
    return m.id;
  }
  async function verify(project: string) {
    const r = await createVerificationRun(c, project, { environment_id: replEnv });
    await drain(env, ['verify']);
    const rows = await db.query<{ name: string; outcome: string; raw_equal: boolean | null; normalized: boolean; normalization_trace: { channel: string; normalizer: string }[]; differences: Record<string, any>[]; diagnostics: Record<string, any> | null }>(
      `SELECT tc.name, vr.outcome, vr.raw_equal, vr.normalized, vr.normalization_trace, vr.differences, vr.diagnostics FROM verification_results vr JOIN test_cases tc ON tc.id=vr.test_case_id WHERE vr.verification_run_id=$1`, [r.run_id]);
    return { runId: r.run_id, byName: Object.fromEntries(rows.map((x) => [x.name, x])) };
  }


  async function exportAndReplay(project: string, runId: string, includeOriginal = false) {
    const ex = await createExport(c, project, { verification_run_id: runId, include_original_binary: includeOriginal });
    await drain(env, ['export']);
    const row = (await db.query<{ package_blob_sha256: string; sums_sha256: string; created_at: string }>('SELECT package_blob_sha256, sums_sha256, created_at FROM export_packages WHERE id=$1', [ex.export_id]))[0];
    expect(row.package_blob_sha256).toBeTruthy();
    const work = mkdtempSync(join(tmpdir(), 's5-export-'));
    writeFileSync(join(work, 'p.zip'), await c.store.get(org, row.package_blob_sha256));
    execFileSync('unzip', ['-q', join(work, 'p.zip'), '-d', work]);
    const pkg = join(work, readdirSync(work).find((d) => d.startsWith('legacy-bridge-'))!);
    const node = process.execPath;
    expect(execFileSync(node, [join(pkg, 'harness/verify-integrity.mjs')], { encoding: 'utf8' })).toContain('integrity ok');
    const stored = JSON.parse(readFileSync(join(pkg, 'results/verification-summary.json'), 'utf8')) as { cases: Record<string, string> };
    const hostOut = join(work, 'host.json');
    execFileSync(node, [join(pkg, 'harness/run-cases.mjs'), '--out', hostOut], { encoding: 'utf8', cwd: tmpdir() });
    expect(JSON.parse(readFileSync(hostOut, 'utf8')).cases).toEqual(stored.cases);
    const dockerOut = join(work, 'docker.json');
    execFileSync(node, [join(pkg, 'harness/run-cases.mjs'), '--docker', '--docker-bin', docker!, '--out', dockerOut], { encoding: 'utf8', cwd: tmpdir(), timeout: 240_000 });
    expect(JSON.parse(readFileSync(dockerOut, 'utf8')).cases).toEqual(stored.cases);
    return { ex, row, pkg, work, stored };
  }

  beforeAll(async () => {
    for (const image of [IMAGE, NODE_IMAGE]) {
      try { execFileSync(docker!, ['image', 'inspect', image], { stdio: 'ignore', timeout: 15_000 }); }
      catch { execFileSync(docker!, ['pull', image], { stdio: 'inherit', timeout: 240_000 }); }
    }
    db = await testDb();
    c = { db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 's5-blobs-'))), orgId: org, userId: user };
    await db.query("INSERT INTO organizations(id,name,execution_enabled) VALUES ($1,'o',true)", [org]);
    await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
    origEnv = await ensureEnvironment(db, { name: 'original-glibc', version: 1, role: 'original', image_digest: IMAGE, arch: 'x86-64', controls: CONTROLS });
    replEnv = await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: NODE_IMAGE, arch: process.arch, controls: CONTROLS });
    env = { db, store: c.store, workRoot: mkdtempSync(join(tmpdir(), 's5-work-')), workerId: 'w-s5', original: new DockerOriginalRunner({ docker }), replacement: new DockerReplacementRunner(NODE_IMAGE), build: (files) => localBuild(files, { repoRoot: root }) };
  }, 300_000);

  it('intcalc: naive replacement differs with a location; a tolerance policy covers rounding but not overflow', async () => {
    const { project, source } = await importProject('intcalc', 'intcalc');
    await requestProbe(c, project, { source_revision_id: source, environment_id: origEnv, argv: ['1', '2'] });
    await drain(env, ['probe']);
    const ids: string[] = [];
    for (const k of INTCALC) ids.push((await createTestCase(c, project, k.name, { argv: k.argv })).id);
    await createPolicy(c, project, null); // default: everything exact
    await requestCapture(c, project, { source_revision_id: source, environment_id: origEnv, test_case_ids: ids, repeat: 2 });
    await drain(env, ['capture']);
    await addModule(project, await approveScope(project), NAIVE);

    // 1. exact policy: located differences
    const exact = await verify(project);
    expect(exact.byName['exact third'].outcome).toBe('match');
    expect(exact.byName['negative'].outcome).toBe('match');
    expect(exact.byName['bad args'].outcome).toBe('match'); // exit 2 + usage is an observation and matches
    for (const n of ['round up', 'round up two', 'overflow']) {
      expect(exact.byName[n].outcome, n).toBe('difference');
      expect(exact.byName[n].differences[0], n).toMatchObject({ channel: 'stdout', kind: 'content', first_difference: { byte: expect.any(Number), line: 1, column: expect.any(Number) } });
    }
    // "0.67\n" vs "0.66\n": the first differing byte is the last digit
    expect(exact.byName['round up'].differences[0].first_difference).toEqual({ byte: 3, line: 1, column: 4 });

    // 2. tolerance policy: rounding is covered, overflow is not, and the trace says so
    await createPolicy(c, project, { engine: '1.1.0', stdout: { mode: 'tolerance' }, numeric: { applies_to: 'stdout', tokenizer: 'decimal-v1', abs: 0.011, rel: 0 } });
    const tol = await verify(project);
    expect(tol.runId).not.toBe(exact.runId);
    for (const n of ['round up', 'round up two']) {
      expect(tol.byName[n], n).toMatchObject({ outcome: 'match', normalized: true, raw_equal: false });
      expect(tol.byName[n].normalization_trace.length, `${n} has a trace`).toBeGreaterThan(0);
      expect(tol.byName[n].normalization_trace[0]).toMatchObject({ channel: 'stdout' });
    }
    for (const n of ['exact third', 'negative', 'bad args']) expect(tol.byName[n], n).toMatchObject({ outcome: 'match', raw_equal: true });
    expect(tol.byName['overflow'].outcome).toBe('difference');
    expect(tol.byName['overflow'].differences[0]).toMatchObject({ channel: 'stdout' });

    // S6: export the tolerance run with the original included. Replay (host and container) must reproduce the stored outcomes exactly.
    const e = await exportAndReplay(project, tol.runId, true);
    expect(Object.values(e.stored.cases).sort()).toEqual(['difference', 'match', 'match', 'match', 'match', 'match']);
    const original = join(e.work, 'original.json');
    const orig = spawnSync(process.execPath, [join(e.pkg, 'harness/run-cases.mjs'), '--original', '--docker-bin', docker!, '--out', original], { encoding: 'utf8', cwd: tmpdir(), timeout: 240_000 });
    expect(orig.status, `--original: ${orig.stdout}\n${orig.stderr}`).toBe(0);
    expect(existsSync(original)).toBe(true);
    const unresolved = JSON.parse(readFileSync(join(e.pkg, 'unresolved.json'), 'utf8'));
    expect(unresolved.cases.length).toBeGreaterThan(0); // the overflow difference is listed, not hidden
    // same binding => identical SHA256SUMS, even after the run has gone stale (a new policy moves the head)
    await createPolicy(c, project, null);
    const again = await buildExport({ db, store: c.store, orgId: org, exportId: e.ex.export_id, createdAt: '2099-01-01T00:00:00.000Z', repoRoot: root, includeOriginal: true });
    expect(again.sumsSha).toBe(e.row.sums_sha256);
  }, 600_000);

  it('rand: a nondeterministic reference never matches without an explicit rule', async () => {
    const { project, source } = await importProject('rand', 'rand');
    await requestProbe(c, project, { source_revision_id: source, environment_id: origEnv });
    await drain(env, ['probe']);
    const tc = (await createTestCase(c, project, 'sample', {})).id;
    await createPolicy(c, project, null);
    await requestCapture(c, project, { source_revision_id: source, environment_id: origEnv, test_case_ids: [tc], repeat: 3 });
    await drain(env, ['capture']);
    const ref = (await db.query<{ deterministic: boolean; variance: { channels: string[] } | null; provenance: string }>('SELECT deterministic, variance, provenance FROM reference_outputs WHERE test_case_id=$1', [tc]))[0];
    expect(ref).toMatchObject({ provenance: 'captured_original', deterministic: false });
    expect(ref.variance?.channels).toContain('stdout');
    await addModule(project, await approveScope(project), RAND_MODULE);

    const strict = await verify(project);
    expect(strict.byName['sample'].outcome).toBe('needs_reference');
    expect(strict.byName['sample'].diagnostics).toMatchObject({ reason: 'nondeterministic_reference', uncovered_channels: ['stdout'] });

    // an explicit rule on the varying channel is the only way through, and the channel is reported as not compared
    await createPolicy(c, project, { engine: '1.1.0', stdout: { mode: 'ignore', reason: 'Value is random by design (scope c1)' } });
    const ruled = await verify(project);
    expect(ruled.byName['sample'].outcome).toBe('match');
    const row = (await db.query<{ summary: Record<string, number> }>('SELECT summary FROM verification_runs WHERE id=$1', [ruled.runId]))[0];
    expect(row.summary.match).toBe(1);

    const e = await exportAndReplay(project, ruled.runId);
    expect(Object.values(e.stored.cases)).toEqual(['match']);
    const prov = JSON.parse(readFileSync(join(e.pkg, 'cases', Object.keys(e.stored.cases)[0], 'provenance.json'), 'utf8'));
    expect(prov).toMatchObject({ provenance: 'captured_original', deterministic: false });
    expect(JSON.parse(readFileSync(join(e.pkg, 'MANIFEST.json'), 'utf8')).unresolved.ignored_channels).toContain('stdout');
  }, 600_000);
});
