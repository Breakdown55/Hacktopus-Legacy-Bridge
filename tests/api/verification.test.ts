/**
 * S5 verification run lifecycle: cancel midway, crash and resume, insert-only results, re-request after cancel.
 * Substitutes: PGlite (single connection; set TEST_DATABASE_URL for real Postgres), FsBlobStore, the UNSANDBOXED
 * LocalReplacementRunner (host node, not Docker), a real local `tsc` build, and user-supplied references seeded through
 * the domain (no original executable is run, so the fake original runner always throws).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import type { Ctx } from '../../server/domain/ctx';
import { claim, cancel, reap } from '../../server/jobs/queue';
import { createCaseSet, createPolicy, createTestCase, supplyReference, type CaseSetEntry } from '../../server/domain/cases';
import { createScopeRevision, decideScope, putScopeDraft } from '../../server/domain/projects';
import { createModuleRevision } from '../../server/domain/modules';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { createVerificationRun, recordResult } from '../../server/domain/verification';
import { drain } from '../../workers/main';
import { verifyHandler } from '../../workers/handlers/verify';
import { localBuild } from '../../workers/build/local';
import { LocalReplacementRunner, type ReplacementRunner } from '../../workers/execution/runners';
import type { JobControl, WorkerEnv } from '../../workers/runtime';

const root = join(__dirname, '../..');
const org = uuidv7(), user = uuidv7(), project = uuidv7(), src = uuidv7();
const CASES = 8;
let db: Db, c: Ctx, env: WorkerEnv, replEnv: string;
let calls: string[] = [];
let afterCall: (n: number) => Promise<void> = async () => {};

/** Counts invocations (by argv) and lets a test act after the Nth case has run. */
const counting: ReplacementRunner = {
  async run(a) {
    const out = await new LocalReplacementRunner().run(a);
    calls.push(a.case.argv[0]);
    await afterCall(calls.length);
    return out;
  },
};

const runRow = async (id: string) => (await db.query<{ completeness: string | null; summary: Record<string, number> | null; job_id: string; binding_digest: string }>('SELECT completeness, summary, job_id, binding_digest FROM verification_runs WHERE id=$1', [id]))[0];
const results = (id: string) => db.query<{ test_case_id: string; outcome: string }>('SELECT test_case_id, outcome FROM verification_results WHERE verification_run_id=$1', [id]);
const jobStatus = async (id: string) => (await db.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [id]))[0].status;
const noDuplicates = async (id: string) => {
  const rows = await results(id);
  expect(new Set(rows.map((r) => r.test_case_id)).size).toBe(rows.length);
  return rows;
};

beforeAll(async () => {
  db = await testDb();
  const store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'ver-blobs-')));
  c = { db, store, orgId: org, userId: user };
  await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [org]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [project, org]);
  await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [org, 'd'.repeat(64)]);
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, org, project]);
  await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/tool','primary_executable',$3,1)", [src, org, 'd'.repeat(64)]);
  await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [project, src]);
  replEnv = await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: 'sha256:' + 'e'.repeat(64), arch: process.arch, controls: CONTROLS });
  env = {
    db, store, workRoot: mkdtempSync(join(tmpdir(), 'ver-work-')), workerId: 'w-ver',
    original: { run: async () => { throw new Error('the original is never run here'); } },
    replacement: counting, build: (files) => localBuild(files, { repoRoot: root }),
  };

  await putScopeDraft(db, org, project, { workflow: { name: 'echo', invocation: { argv_template: ['{n}'], stdin: 'none' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'echo', statement: 'Prints its first argument and a newline', basis: 'observed' }] }, null, user);
  const scope = await createScopeRevision(db, org, project, 1, user);
  await decideScope(db, org, project, scope.id, 'approved', scope.document_sha256, user);
  await createModuleRevision(c, project, { scope_revision_id: scope.id, origin: 'customer_upload', files: [{ path: 'src/index.ts', content: "export async function run(input: { argv: string[] }): Promise<{ stdout?: string; exitCode?: number }> { return { stdout: input.argv[0] + '\\n', exitCode: 0 }; }\n" }] });
  await drain(env, ['build']);

  const entries: CaseSetEntry[] = [];
  for (let i = 0; i < CASES; i++) {
    const tc = await createTestCase(c, project, `case ${i}`, { argv: [String(i)] });
    const ref = await supplyReference(c, tc.id, { exit: { code: 0, signal: null }, stdout: { text: `${i}\n` } }, 'seeded for the lifecycle tests');
    entries.push({ test_case_id: tc.id, reference_output_id: ref.id });
  }
  await createCaseSet(c, project, entries);
  await createPolicy(c, project, null);
}, 300_000);

describe('S5 verification run lifecycle', () => {
  it('cancelling midway keeps the completed results, marks the run partial, and leaves no duplicates', async () => {
    calls = [];
    const { run_id, job_id, reused } = await createVerificationRun(c, project, { environment_id: replEnv });
    expect(reused).toBe(false);
    afterCall = async (n) => { if (n === 3) expect(await cancel(db, org, job_id)).toBe('cancel_requested'); };
    try { await drain(env, ['verify']); } finally { afterCall = async () => {}; }
    expect(await jobStatus(job_id)).toBe('cancelled');
    const run = await runRow(run_id);
    expect(run.completeness).toBe('partial');
    const rows = await noDuplicates(run_id);
    expect(rows).toHaveLength(3);
    expect(run.summary).toEqual({ match: 3, difference: 0, couldnt_run: 0, needs_reference: 0 });
    expect(calls).toHaveLength(3);
  }, 120_000);

  it('a cancelled run that is requested again becomes a new run with the same binding, and the old partial run is kept', async () => {
    const old = (await db.query<{ id: string; binding_digest: string }>("SELECT id, binding_digest FROM verification_runs WHERE completeness='partial'"))[0];
    calls = [];
    const again = await createVerificationRun(c, project, { environment_id: replEnv });
    expect(again.reused).toBe(false);
    expect(again.run_id).not.toBe(old.id);
    expect(again.binding_digest).toBe(old.binding_digest);
    expect(again.job_id).not.toBe((await runRow(old.id)).job_id);
    await drain(env, ['verify']);
    const fresh = await runRow(again.run_id);
    expect(fresh).toMatchObject({ completeness: 'complete', summary: { match: CASES, difference: 0, couldnt_run: 0, needs_reference: 0 } });
    expect(await noDuplicates(again.run_id)).toHaveLength(CASES);
    expect(calls).toHaveLength(CASES); // a new run starts over: results belong to a run, not to a binding
    expect((await runRow(old.id)).completeness).toBe('partial');
    expect(await noDuplicates(old.id)).toHaveLength(3);
    // Only the complete run is reused from now on.
    expect(await createVerificationRun(c, project, { environment_id: replEnv })).toMatchObject({ reused: true, run_id: again.run_id });
  }, 120_000);

  it('after a worker crash the reaper requeues the job and the retry resumes without re-running finished cases', async () => {
    // A different case set (reversed order) gives a different binding, so this is a fresh run.
    const entries = (await db.query<{ entries: CaseSetEntry[] }>('SELECT entries FROM case_set_revisions WHERE project_id=$1 ORDER BY number DESC LIMIT 1', [project]))[0].entries;
    await createCaseSet(c, project, [...entries].reverse());
    calls = [];
    const { run_id, job_id } = await createVerificationRun(c, project, { environment_id: replEnv });
    const job = (await claim(db, 'w-crashing', ['verify']))!;
    expect(job.id).toBe(job_id);
    const K = 3;
    let checkpoints = 0;
    const dying: JobControl = { async checkpoint() { if (checkpoints++ === K) throw new Error('simulated process crash'); } };
    await expect(verifyHandler(env, job, dying)).rejects.toThrow('simulated process crash');
    expect(await noDuplicates(run_id)).toHaveLength(K);
    expect(calls).toHaveLength(K);
    expect((await runRow(run_id)).completeness).toBeNull();
    expect(await jobStatus(job_id)).toBe('running'); // nobody finished it: the process is gone

    await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id=$1", [job_id]);
    expect(await reap(db, 'verify', org)).toBe(1);
    expect(await jobStatus(job_id)).toBe('queued');
    await drain(env, ['verify']);
    expect(await jobStatus(job_id)).toBe('succeeded');
    expect(await runRow(run_id)).toMatchObject({ completeness: 'complete', summary: { match: CASES } });
    expect(await noDuplicates(run_id)).toHaveLength(CASES);
    expect(calls).toHaveLength(CASES); // K before the crash plus CASES-K after: nothing ran twice
    expect(new Set(calls).size).toBe(CASES);
  }, 120_000);

  it('recordResult is insert-only: a second delivery for the same case leaves one row and does not overwrite it', async () => {
    const [run] = await db.query<{ id: string }>("SELECT id FROM verification_runs WHERE completeness='complete' LIMIT 1");
    const [row] = await db.query<{ test_case_id: string; reference_output_id: string | null; outcome: string }>('SELECT test_case_id, reference_output_id, outcome FROM verification_results WHERE verification_run_id=$1 LIMIT 1', [run.id]);
    expect(row.outcome).toBe('match');
    const dup = await recordResult(db, { id: uuidv7(), orgId: org, runId: run.id, testCaseId: row.test_case_id, referenceOutputId: row.reference_output_id, outcome: 'difference', actual: null, rawEqual: false, normalized: false, trace: [], differences: [{ channel: 'exit' }], diagnostics: null, durationMs: 1 });
    expect(dup).toBe(false);
    const rows = await db.query<{ outcome: string }>('SELECT outcome FROM verification_results WHERE verification_run_id=$1 AND test_case_id=$2', [run.id, row.test_case_id]);
    expect(rows).toEqual([{ outcome: 'match' }]);
  });
});
