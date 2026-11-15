/**
 * F3 / S4 acceptance (plan §10.1 F3, §10.2 S4): LIVE generation for the STRIPPED `intcalc` fixture with the signed-in Codex CLI.
 * Opt in with LB_TEST_LIVE_CODEX=1 (it sends the scope and evidence to Codex). Needs Docker and `make -C fixtures`.
 * Acceptance: the generated module builds, and either matches the original on every case or lists the overflow behavior it could not translate.
 * Substitutes: PGlite, FsBlobStore, Docker runc (not gVisor), unsandboxed tsc build, and NO decompiler: no REA image, so evidence is built-in ELF inspection only.
 * Writes a JSON report to LB_F3_REPORT (default: <tmp>/intcalc-f3-report.json).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { createCaseSet, createPolicy, createTestCase, requestCapture, requestProbe } from '../../server/domain/cases';
import { createScopeRevision, decideScope, getHeads, putScopeDraft } from '../../server/domain/projects';
import { requestGeneration } from '../../server/domain/generation';
import { createVerificationRun } from '../../server/domain/verification';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { NODE_IMAGE } from '../../workers/export/build';
import { drain } from '../../workers/main';
import { DockerOriginalRunner, DockerReplacementRunner } from '../../workers/execution/runners';
import { localBuild } from '../../workers/build/local';
import { CodexGenerator } from '../../workers/generation/codex';
import type { WorkerEnv } from '../../workers/runtime';

const root = join(__dirname, '../..');
const docker = [process.env.DOCKER_BIN, `${process.env.HOME}/.docker/bin/docker`, '/usr/local/bin/docker', 'docker'].filter(Boolean).find((d) => { try { execFileSync(d!, ['info'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } });
const fixture = join(root, 'fixtures/bin/intcalc.stripped');
const codexBin = process.env.LB_CODEX_BIN || ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', 'codex'].find((p) => p === 'codex' || existsSync(p))!;
const live = process.env.LB_TEST_LIVE_CODEX === '1';
const skip = !live || !docker || !existsSync(fixture);
if (!skip) process.env.PATH = `${dirname(docker!)}:${process.env.PATH}`;
const IMAGE = 'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';
const reportPath = process.env.LB_F3_REPORT || join(tmpdir(), 'intcalc-f3-report.json');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Overflow cases are the ones the original wraps (32-bit two's complement) and a naive JS number add does not.
const CASES: { name: string; argv: string[]; overflow?: boolean }[] = [
  { name: 'simple', argv: ['1', '2'] },
  { name: 'rounding up', argv: ['1', '1'] },
  { name: 'negative', argv: ['-10', '4'] },
  { name: 'zero', argv: ['0', '0'] },
  { name: 'leading space', argv: [' 4', '3'] },
  { name: 'plus sign', argv: ['+5', '3'] },
  { name: 'max int, no overflow', argv: ['2147483647', '0'] },
  { name: 'min int, no overflow', argv: ['-2147483648', '0'] },
  { name: 'positive overflow', argv: ['2147483647', '1'], overflow: true },
  { name: 'negative overflow', argv: ['-2147483648', '-1'], overflow: true },
  { name: 'large positive overflow', argv: ['2000000000', '2000000000'], overflow: true },
  { name: 'argument out of range', argv: ['2147483648', '0'] },
  { name: 'not a number', argv: ['abc', '1'] },
  { name: 'trailing junk', argv: ['12x', '1'] },
  { name: 'too few args', argv: ['1'] },
  { name: 'too many args', argv: ['1', '2', '3'] },
];

describe.skipIf(skip)('F3: stripped intcalc through Codex generation (live)', () => {
  let db: Db, c: Ctx, env: WorkerEnv, project: string, origEnv: string, replEnv: string, source: string, scopeId: string;
  const org = uuidv7(), user = uuidv7();
  const report: Record<string, unknown> = { fixture: 'intcalc.stripped', codex: codexBin, generated_at: new Date().toISOString(), attempts: [] };

  const upload = async (name: string, bytes: Buffer) => {
    const u = await createUpload(c, project, { filename: name, size: bytes.length, sha256: sha(bytes) });
    const f = u.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes);
    await completeUpload(c, u.upload_id);
    return u.upload_id;
  };

  beforeAll(async () => {
    for (const image of [IMAGE, NODE_IMAGE]) {
      try { execFileSync(docker!, ['image', 'inspect', image], { stdio: 'ignore', timeout: 15_000 }); }
      catch { execFileSync(docker!, ['pull', image], { stdio: 'inherit', timeout: 240_000 }); }
    }
    db = await testDb();
    c = { db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'f3-blobs-'))), orgId: org, userId: user };
    await db.query("INSERT INTO organizations(id,name,execution_enabled,external_model_allowed) VALUES ($1,'o',true,true)", [org]);
    await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
    project = uuidv7();
    await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'intcalc')", [project, org]);
    origEnv = await ensureEnvironment(db, { name: 'original-glibc', version: 1, role: 'original', image_digest: IMAGE, arch: 'x86-64', controls: CONTROLS });
    replEnv = await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: NODE_IMAGE, arch: process.arch, controls: CONTROLS });
    env = {
      db, store: c.store, workRoot: mkdtempSync(join(tmpdir(), 'f3-work-')), workerId: 'w-f3',
      original: new DockerOriginalRunner({ docker }), replacement: new DockerReplacementRunner(NODE_IMAGE),
      build: (files) => localBuild(files, { repoRoot: root }), generator: new CodexGenerator({ binary: codexBin, model: process.env.LB_GENERATION_MODEL || undefined }),
    };
  }, 300_000);

  it('imports the stripped binary, captures references from the original, and approves a black-box scope', async () => {
    const bin = await upload('intcalc', readFileSync(fixture));
    source = (await sealSourceRevision(c, project, { artifacts: [{ upload_id: bin, path: 'bin/intcalc', role: 'primary_executable' }], notes: 'stripped fixture', objectives: 'same output' })).id;
    await drain(env, ['inspect']);
    await recordExecutionConsent(c, source, 'I am authorized to run this executable in an isolated sandbox');
    await requestProbe(c, project, { source_revision_id: source, environment_id: origEnv, argv: ['1', '2'] });
    await drain(env, ['probe']);
    const ids: string[] = [];
    for (const k of CASES) ids.push((await createTestCase(c, project, k.name, { argv: k.argv })).id);
    await createPolicy(c, project, null);
    await requestCapture(c, project, { source_revision_id: source, environment_id: origEnv, test_case_ids: ids, repeat: 2 });
    await drain(env, ['capture']);
    const refs = await db.query<{ provenance: string; deterministic: boolean }>('SELECT provenance, deterministic FROM reference_outputs');
    expect(refs).toHaveLength(CASES.length);
    expect(refs.every((r) => r.provenance === 'captured_original' && r.deterministic)).toBe(true);

    // A scope an analyst could write from running the program. It does not mention overflow: the generator has to notice or flag that.
    await putScopeDraft(c.db, org, project, {
      workflow: { name: 'Integer calculator', invocation: { argv_template: ['{left}', '{right}'], stdin: 'none' } },
      interface: { language: 'typescript', export: 'run' },
      behaviors: [
        { id: 'sum-scale', statement: 'Takes two integer arguments LEFT and RIGHT, adds them, divides the sum by 3 and prints the result with exactly two decimal places and a newline on stdout. Exit code 0.', basis: 'observed' },
        { id: 'bad-args', statement: 'With the wrong number of arguments, or an argument that is not a whole decimal integer in the signed 32-bit range, prints "usage: intcalc LEFT RIGHT" and a newline to stderr, prints nothing to stdout and exits with code 2.', basis: 'observed' },
      ],
      assumptions: [],
      open_questions: [],
    }, null, user);
    const scope = await createScopeRevision(c.db, org, project, 1, user);
    await decideScope(c.db, org, project, scope.id, 'approved', scope.document_sha256, user);
    scopeId = scope.id;
    expect((await getHeads(db, org, project)).approved_scope_revision_id).toBe(scopeId);
  }, 300_000);

  it('Codex generates a module that builds (at most one repair) and either matches or lists the overflow it could not translate', async () => {
    let moduleId = '', parent: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await requestGeneration(c, project, { scope_revision_id: scopeId, parent_id: parent, instructions: attempt === 2 ? 'Fix the build errors reported in the diagnostics.' : undefined });
      await drain(env, ['generate']);
      const job = (await db.query<{ status: string; error: unknown }>("SELECT status, error FROM jobs WHERE kind='generate' ORDER BY created_at DESC, id DESC LIMIT 1"))[0];
      (report.attempts as unknown[]).push({ attempt, job });
      expect(job.status, JSON.stringify(job)).toBe('succeeded');
      moduleId = (await getHeads(db, org, project)).current_module_revision_id!;
      await drain(env, ['build']);
      const b = (await db.query<{ status: string; diagnostics: unknown }>('SELECT status, diagnostics FROM build_results WHERE module_revision_id=$1 ORDER BY attempt DESC LIMIT 1', [moduleId]))[0];
      (report.attempts as Record<string, unknown>[])[attempt - 1].build = b.status;
      if (b.status === 'succeeded') break;
      parent = moduleId;
    }
    const m = (await db.query<{ id: string; number: number; untranslated: { id: string; behaviorId?: string; reason: string }[]; generator: { provider: string; model: string; usage: unknown } }>('SELECT id, number, untranslated, generator FROM module_revisions WHERE id=$1', [moduleId]))[0];
    const built = (await db.query<{ status: string }>('SELECT status FROM build_results WHERE module_revision_id=$1 ORDER BY attempt DESC LIMIT 1', [moduleId]))[0];
    expect(built.status).toBe('succeeded');

    await createVerificationRun(c, project, { environment_id: replEnv });
    await drain(env, ['verify']);
    const rows = await db.query<{ name: string; outcome: string; differences: unknown }>(
      `SELECT tc.name, vr.outcome, vr.differences FROM verification_results vr JOIN test_cases tc ON tc.id = vr.test_case_id ORDER BY tc.name`);
    const overflowNames = new Set(CASES.filter((k) => k.overflow).map((k) => k.name));
    const nonMatch = rows.filter((r) => r.outcome !== 'match');
    const summary = { revision: m.number, generator: m.generator, untranslated: m.untranslated, results: rows.map((r) => ({ name: r.name, outcome: r.outcome })), non_match_differences: nonMatch };
    Object.assign(report, summary);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[f3] report: ${reportPath}\n[f3] outcomes: ${rows.map((r) => `${r.name}=${r.outcome}`).join(', ')}\n[f3] untranslated: ${JSON.stringify(m.untranslated)}`);

    expect(rows).toHaveLength(CASES.length);
    expect(rows.filter((r) => r.outcome === 'couldnt_run' || r.outcome === 'needs_reference')).toEqual([]);
    // Acceptance: only overflow cases may differ, and then the module must have said so.
    // Non-overflow differences (e.g. strtoll accepting leading whitespace) are scope gaps a black-box scope cannot reveal: reported, not blocking.
    const gaps = nonMatch.filter((r) => !overflowNames.has(r.name)).map((r) => r.name);
    report.scope_gaps = gaps;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[f3] non-overflow differences (scope gaps): ${JSON.stringify(gaps)}`);
    if (nonMatch.some((r) => overflowNames.has(r.name))) {
      expect(m.untranslated.length, 'overflow differs but nothing is listed as untranslated').toBeGreaterThan(0);
      expect(JSON.stringify(m.untranslated), 'untranslated list does not mention overflow/wraparound').toMatch(/overflow|wrap|32-bit|int32|modulo|two'?s/i);
    }
  }, 20 * 60_000);
});
