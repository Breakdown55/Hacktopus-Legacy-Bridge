/**
 * S1 end-to-end (plan §10.2): real x86-64 ELF fixture, run in Docker, driven through the domain services and the worker.
 * Skips (with a reason) when Docker or the built fixtures are missing: run `make -C fixtures` and start Docker.
 * Note: Docker Desktop uses plain runc, not gVisor. Isolation flags are applied, the gVisor runtime is not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cpSync, rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import type { Ctx } from '../../server/domain/ctx';
import { createUpload, completeUpload, getSourceStatus, recordExecutionConsent, sealSourceRevision } from '../../server/domain/sources';
import { createCaseSet, createPolicy, createTestCase, requestCapture, requestProbe } from '../../server/domain/cases';
import { createScopeRevision, decideScope, getHeads, putScopeDraft } from '../../server/domain/projects';
import { getProgress } from '../../server/domain/queries';
import { createModuleRevision } from '../../server/domain/modules';
import { appliesToCurrent, createVerificationRun } from '../../server/domain/verification';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { createExport } from '../../server/domain/exports';
import { buildExport, NODE_IMAGE } from '../../workers/export/build';
import { drain } from '../../workers/main';
import { DockerOriginalRunner, DockerReplacementRunner } from '../../workers/execution/runners';
import { localBuild } from '../../workers/build/local';
import type { WorkerEnv } from '../../workers/runtime';

const root = join(__dirname, '../..');
const docker = [process.env.DOCKER_BIN, `${process.env.HOME}/.docker/bin/docker`, '/usr/local/bin/docker', 'docker'].filter(Boolean).find((d) => { try { execFileSync(d!, ['info'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } });
const haveFixture = existsSync(join(root, 'fixtures/bin/wordfreq'));
const IMAGE = 'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';
const skip = !docker || !haveFixture;
if (skip) console.warn(`[e2e] SKIPPED: docker=${docker ?? 'unavailable'} fixture=${haveFixture ? 'present' : 'missing (make -C fixtures)'}`);
if (docker) process.env.PATH = `${dirname(docker)}:${process.env.PATH}`;

const readdirSyncSafe = (d: string) => readdirSync(d);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const STOP = 'the\nand\nof\n';
const CASES: { name: string; argv?: string[]; stdin?: string; stopwords?: boolean }[] = [
  { name: 'top3 basic', argv: ['--top', '3'], stdin: 'a b a c a b' },
  { name: 'default top', stdin: 'one two two three three three four four four four five five five five five six six six six six six' },
  { name: 'top1', argv: ['--top', '1'], stdin: 'x y y' },
  { name: 'empty stdin' },
  { name: 'bad flag', argv: ['--nope'] },
  { name: 'top zero', argv: ['--top', '0'] },
  { name: 'with stopwords', argv: ['--top', '5'], stdin: 'the cat and the dog of the bird', stopwords: true },
  { name: 'mixed case + punctuation', stdin: 'Hello, HELLO! hello... World; world?' },
  { name: 'tie break alphabetical', argv: ['--top', '4'], stdin: 'pear apple fig kiwi' },
  { name: 'non-ascii bytes', stdin: 'café café naïve' },
];
const V1 = ['index.ts'].map((f) => ({ path: `src/${f}`, content: readFileSync(join(root, 'fixtures/replacements/wordfreq-v1/src', f), 'utf8') }));

describe.skipIf(skip)('S1: import -> export (real ELF in Docker)', () => {
  let db: Db, c: Ctx, env: WorkerEnv, project: string, origEnv: string, replEnv: string, source: string;
  const org = uuidv7(), user = uuidv7();

  const upload = async (name: string, bytes: Buffer) => {
    const u = await createUpload(c, project, { filename: name, size: bytes.length, sha256: sha(bytes) });
    const f = u.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes);
    await completeUpload(c, u.upload_id);
    return u.upload_id;
  };

  beforeAll(async () => {
    // Image download progress is Docker's stderr, not part of an executable's observation.
    for (const image of [IMAGE, NODE_IMAGE]) {
      try { execFileSync(docker!, ['image', 'inspect', image], { stdio: 'ignore', timeout: 15_000 }); }
      catch { execFileSync(docker!, ['pull', image], { stdio: 'inherit', timeout: 240_000 }); }
    }
    db = await testDb();
    const store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'e2e-blobs-')));
    c = { db, store, orgId: org, userId: user };
    await db.query("INSERT INTO organizations(id,name,execution_enabled) VALUES ($1,'o',true)", [org]);
    await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
    project = uuidv7();
    await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'wordfreq')", [project, org]);
    origEnv = await ensureEnvironment(db, { name: 'original-glibc', version: 1, role: 'original', image_digest: IMAGE, arch: 'x86-64', controls: CONTROLS });
    replEnv = await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: NODE_IMAGE, arch: process.arch, controls: CONTROLS });
    env = { db, store, workRoot: mkdtempSync(join(tmpdir(), 'e2e-work-')), workerId: 'w-test', original: new DockerOriginalRunner({ docker }), replacement: new DockerReplacementRunner(NODE_IMAGE), build: (files) => localBuild(files, { repoRoot: root }) };
  }, 300_000);

  it('1. import: seal a revision and inspect the real ELF', async () => {
    const bin = await upload('wordfreq', readFileSync(join(root, 'fixtures/bin/wordfreq')));
    const rev = await sealSourceRevision(c, project, { artifacts: [{ upload_id: bin, path: 'bin/wordfreq', role: 'primary_executable' }], notes: 'nightly cron', objectives: 'same output' });
    source = rev.id;
    expect(rev.number).toBe(1);
    await drain(env, ['inspect']);
    const st = await getSourceStatus(c, source);
    expect(st.eligibility.analysis.status).toBe('eligible');
    expect(st.eligibility.execution).toMatchObject({ status: 'not_permitted', reasons: ['consent_missing'] }); // analysis and execution are separate
    expect(st.inspection).toMatchObject({ format: 'ELF64', arch: 'x86-64', needed: ['libc.so.6'] });
  });

  it('2. execution requires consent; probe makes it runnable', async () => {
    await expect(requestProbe(c, project, { source_revision_id: source, environment_id: origEnv })).rejects.toMatchObject({ code: 'execution_consent_required' });
    await recordExecutionConsent(c, source, 'I am authorized to run this executable in an isolated sandbox');
    expect((await getSourceStatus(c, source)).eligibility.execution.status).toBe('unknown');
    await requestProbe(c, project, { source_revision_id: source, environment_id: origEnv, argv: ['--top', '1'], stdin_text: 'a' });
    await drain(env, ['probe']);
    expect((await getSourceStatus(c, source)).eligibility.execution).toMatchObject({ status: 'runnable' });
  }, 120_000);

  it('3. capture 10 deterministic references from the original', async () => {
    const ids: string[] = [];
    for (const k of CASES) ids.push((await createTestCase(c, project, k.name, { argv: k.argv, stdin: k.stdin !== undefined ? { text: k.stdin } : undefined, files: k.stopwords ? [{ path: 'stopwords.txt', text: STOP }] : [] })).id);
    await createPolicy(c, project, null);
    await requestCapture(c, project, { source_revision_id: source, environment_id: origEnv, test_case_ids: ids, repeat: 2 });
    await drain(env, ['capture']);
    const refs = await db.query<{ provenance: string; deterministic: boolean }>('SELECT provenance, deterministic FROM reference_outputs');
    expect(refs).toHaveLength(10);
    expect(refs.every((r) => r.provenance === 'captured_original' && r.deterministic === true)).toBe(true);
    const h = await getHeads(db, org, project);
    const cs = (await db.query<{ entries: { reference_output_id: string | null }[] }>('SELECT entries FROM case_set_revisions WHERE id=$1', [h.current_case_set_revision_id]))[0];
    expect(cs.entries).toHaveLength(10);
    expect(cs.entries.every((e) => e.reference_output_id)).toBe(true);
  }, 300_000);

  let moduleV1: string;
  it('4. scope approved, TS replacement built (and a bad module is refused / fails to build)', async () => {
    await putScopeDraft(c.db, org, project, { workflow: { name: 'Top-N word frequency', invocation: { argv_template: ['--top', '{n}'], stdin: 'text' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'b1', statement: 'Words are lower-cased before counting', basis: 'observed' }] }, null, user);
    const scope = await createScopeRevision(c.db, org, project, 1, user);
    await expect(createModuleRevision(c, project, { scope_revision_id: scope.id, origin: 'customer_upload', files: V1 })).rejects.toMatchObject({ code: 'scope_not_approved' });
    await decideScope(c.db, org, project, scope.id, 'approved', scope.document_sha256, user);
    const bad = await createModuleRevision(c, project, { scope_revision_id: scope.id, origin: 'customer_upload', files: [{ path: 'src/index.ts', content: 'export const run: number = "x";' }] });
    await drain(env, ['build']);
    expect((await db.query<{ status: string }>('SELECT status FROM build_results WHERE module_revision_id=$1', [bad.id]))[0].status).toBe('failed');
    await expect(createVerificationRun(c, project, { environment_id: replEnv })).rejects.toMatchObject({ code: 'build_required' });
    const good = await createModuleRevision(c, project, { scope_revision_id: scope.id, origin: 'user_edit', parent_id: bad.id, changes: V1.map((f) => ({ path: f.path, content: f.content })) });
    moduleV1 = good.id;
    expect(good.is_current).toBe(true);
    await drain(env, ['build']);
    expect((await db.query<{ status: string }>('SELECT status FROM build_results WHERE module_revision_id=$1', [good.id]))[0].status).toBe('succeeded');
  }, 120_000);

  let runId: string;
  it('5. verification: 10/10 match; identical request is reused', async () => {
    const r = await createVerificationRun(c, project, { environment_id: replEnv });
    runId = r.run_id;
    expect(r.reused).toBe(false);
    await drain(env, ['verify']);
    const run = (await db.query<{ completeness: string; summary: Record<string, number> }>('SELECT completeness, summary FROM verification_runs WHERE id=$1', [runId]))[0];
    const diffs = await db.query('SELECT test_case_id, differences, diagnostics FROM verification_results WHERE outcome <> $1', ['match']);
    expect(diffs).toEqual([]);
    expect(run).toMatchObject({ completeness: 'complete', summary: { match: 10, difference: 0, couldnt_run: 0, needs_reference: 0 } });
    expect(await appliesToCurrent(db, org, project, runId)).toEqual({ applies_to_current: true, stale_reasons: [] });
    const again = await createVerificationRun(c, project, { environment_id: replEnv });
    expect(again).toMatchObject({ reused: true, run_id: runId });
  }, 120_000);

  it('5b. export: integrity, tamper detection, deterministic SHA256SUMS, offline replay (host and node:22 --network none)', async () => {
    await expect(createExport(c, project, { verification_run_id: uuidv7() })).rejects.toMatchObject({ code: 'not_found' });
    const ex = await createExport(c, project, { verification_run_id: runId });
    await drain(env, ['export']);
    const jobRow = (await db.query<{ status: string; error: unknown }>('SELECT status, error FROM jobs WHERE id=$1', [ex.job_id]))[0];
    expect(JSON.stringify(jobRow)).toContain('succeeded');
    const row = (await db.query<{ package_blob_sha256: string; sums_sha256: string; manifest: any; created_at: string }>('SELECT package_blob_sha256, sums_sha256, manifest, created_at FROM export_packages WHERE id=$1', [ex.export_id]))[0];
    expect(row.package_blob_sha256).toBeTruthy();
    expect((await getProgress(c, project)).completed_steps).toBe(5);
    expect(row.manifest.summary).toMatchObject({ match: 10, difference: 0, couldnt_run: 0, needs_reference: 0 });
    expect(row.manifest.binding.verification_run).toMatchObject({ completeness: 'complete', applies_to_current_at_export: true });

    const work = mkdtempSync(join(tmpdir(), 'e2e-export-'));
    writeFileSync(join(work, 'p.zip'), await c.store.get(org, row.package_blob_sha256));
    execFileSync('unzip', ['-q', join(work, 'p.zip'), '-d', work]);
    const pkg = join(work, readdirSyncSafe(work).find((d) => d.startsWith('legacy-bridge-'))!);

    // integrity + replay on the host, from outside the package, with no repo checkout involved
    const node = process.execPath;
    expect(execFileSync(node, [join(pkg, 'harness/verify-integrity.mjs')], { encoding: 'utf8' })).toContain('integrity ok');
    const replay = execFileSync(node, [join(pkg, 'harness/run-cases.mjs'), '--out', join(work, 'report.json')], { encoding: 'utf8', cwd: tmpdir() });
    expect(replay).toContain('REPLAY OK');
    expect(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')).summary).toEqual({ match: 10, difference: 0, couldnt_run: 0, needs_reference: 0 });

    // clean node:22 container, no network, read-only package
    const out = execFileSync(docker!, ['run', '--rm', '--network', 'none', '-v', `${pkg}:/pkg:ro`, '-w', '/pkg', NODE_IMAGE, 'sh', '-c', 'node harness/verify-integrity.mjs && node harness/run-cases.mjs --out /tmp/r.json'], { encoding: 'utf8', timeout: 120_000 });
    expect(out).toContain('integrity ok');
    expect(out).toContain('REPLAY OK');

    // tamper: editing MANIFEST.json summary.match is detected; so is an extra file and a missing one
    const tampered = join(work, 'tampered'); cpSync(pkg, tampered, { recursive: true });
    const m = readFileSync(join(tampered, 'MANIFEST.json'), 'utf8').replace('"match":10', '"match":11');
    expect(m).not.toBe(readFileSync(join(pkg, 'MANIFEST.json'), 'utf8'));
    writeFileSync(join(tampered, 'MANIFEST.json'), m);
    expect(() => execFileSync(node, [join(tampered, 'harness/verify-integrity.mjs')], { stdio: 'pipe' })).toThrow();
    writeFileSync(join(tampered, 'extra.txt'), 'x');
    rmSync(join(tampered, 'README.md'));
    let err = ''; try { execFileSync(node, [join(tampered, 'harness/verify-integrity.mjs')], { stdio: 'pipe' }); } catch (e) { err = String((e as { stderr: Buffer }).stderr); }
    expect(err).toMatch(/modified: MANIFEST.json/); expect(err).toMatch(/extra: extra.txt/); expect(err).toMatch(/missing: README.md/);

    // same binding => identical SHA256SUMS and MANIFEST; only EXPORT_ID differs
    const again = await buildExport({ db, store: c.store, orgId: org, exportId: ex.export_id, createdAt: '2099-01-01T00:00:00.000Z', repoRoot: root, includeOriginal: false });
    expect(again.sumsSha).toBe(row.sums_sha256);
    expect(again.files.find((f) => f.path === 'EXPORT_ID')!.content.toString()).not.toBe(readFileSync(join(pkg, 'EXPORT_ID'), 'utf8')); // only EXPORT_ID differs
    expect(readFileSync(join(pkg, 'SHA256SUMS'), 'utf8')).toBe(again.files.find((f) => f.path === 'SHA256SUMS')!.content.toString());
  }, 300_000);

  it('6. a buggy second module revision: old run goes stale, new run shows a located difference', async () => {
    const scope = (await getHeads(db, org, project)).approved_scope_revision_id!;
    const buggy = V1.map((f) => ({ ...f, content: f.content.replace("(x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)", '0') }));
    const v2 = await createModuleRevision(c, project, { scope_revision_id: scope, origin: 'user_edit', parent_id: moduleV1, files: buggy });
    await drain(env, ['build']);
    expect(await appliesToCurrent(db, org, project, runId)).toEqual({ applies_to_current: false, stale_reasons: ['module_revision_changed'] });
    const r2 = await createVerificationRun(c, project, { environment_id: replEnv });
    expect(r2.reused).toBe(false);
    await drain(env, ['verify']);
    const sum = (await db.query<{ summary: Record<string, number> }>('SELECT summary FROM verification_runs WHERE id=$1', [r2.run_id]))[0].summary;
    expect(sum.difference).toBeGreaterThan(0);
    const d = await db.query<{ differences: { channel: string; first_difference: { line: number } }[] }>("SELECT differences FROM verification_results WHERE verification_run_id=$1 AND outcome='difference' LIMIT 1", [r2.run_id]);
    expect(d[0].differences[0]).toMatchObject({ channel: 'stdout' });
    // the earlier run's results are unchanged
    expect((await db.query<{ summary: Record<string, number> }>('SELECT summary FROM verification_runs WHERE id=$1', [runId]))[0].summary.match).toBe(10);
    expect(v2.number).toBe(3);
    expect((await getProgress(c, project)).completed_steps).toBe(4);
  }, 120_000);
});
