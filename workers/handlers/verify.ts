import { PolicyRules, type CaseInput, type Observation } from '@lb/contracts';
import { judge } from '@lb/compare';
import type { Job } from '../../server/jobs/queue';
import { uuidv7 } from '../../server/db/ids';
import type { CaseSetEntry } from '../../server/domain/cases';
import { finalizeRun, recordResult } from '../../server/domain/verification';
import { unpackTar } from '../../server/tar';
import { CancelledError, writeTree, type JobControl, type WorkerEnv } from '../runtime';
import { jobDir, loadObservation, storeObservation, tmpIn, toCaseRun } from './common';
import type { RunOutcome } from '../execution/harness';

/**
 * Verification (§4.2): results are written per case as they finish (insert-only); finalize decides complete vs partial.
 * A cancelled run keeps its completed results and finalizes as partial.
 */
export async function verifyHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const runId = job.subject_id!;
  const orgId = job.org_id;
  const run = (await env.db.query<{ project_id: string; build_result_id: string; case_set_revision_id: string; comparison_policy_id: string }>('SELECT project_id, build_result_id, case_set_revision_id, comparison_policy_id FROM verification_runs WHERE id=$1 AND org_id=$2', [runId, orgId]))[0];
  const entries = (await env.db.query<{ entries: CaseSetEntry[] }>('SELECT entries FROM case_set_revisions WHERE id=$1', [run.case_set_revision_id]))[0].entries;
  const policy = PolicyRules.parse((await env.db.query<{ rules: unknown }>('SELECT rules FROM comparison_policies WHERE id=$1', [run.comparison_policy_id]))[0].rules);
  const outSha = (await env.db.query<{ output_blob_sha256: string }>('SELECT output_blob_sha256 FROM build_results WHERE id=$1', [run.build_result_id]))[0].output_blob_sha256;
  const dir = jobDir(env, job.id);
  const moduleDir = tmpIn(dir, 'module-');
  writeTree(moduleDir, unpackTar(await env.store.get(orgId, outSha)));

  const have = new Set((await env.db.query<{ test_case_id: string }>('SELECT test_case_id FROM verification_results WHERE verification_run_id=$1', [runId])).map((r) => r.test_case_id));
  let done = have.size, cancelled = false;
  for (const e of entries) {
    if (have.has(e.test_case_id)) continue; // retry after crash: resume
    try { await ctl.checkpoint({ phase: 'running_cases', completed: done, total: entries.length, message: `case ${e.test_case_id}` }); }
    catch (err) { if (err instanceof CancelledError) { cancelled = true; break; } throw err; }

    const tc = (await env.db.query<{ input: CaseInput }>('SELECT input FROM test_cases WHERE id=$1 AND org_id=$2', [e.test_case_id, orgId]))[0];
    let ref = null;
    if (e.reference_output_id) {
      const r = (await env.db.query<{ observation: Observation; deterministic: boolean | null; variance: { channels?: string[] } | null }>('SELECT observation, deterministic, variance FROM reference_outputs WHERE id=$1 AND org_id=$2', [e.reference_output_id, orgId]))[0];
      ref = await loadObservation(env.store, orgId, r.observation, { deterministic: r.deterministic, variance: r.variance });
    }
    const t0 = Date.now();
    let out: RunOutcome | null = null;
    let diag: Record<string, unknown> | null = null;
    try { out = await env.replacement.run({ moduleDir, workdir: tmpIn(dir, 'w-'), case: await toCaseRun(env.store, orgId, tc.input) }); }
    catch (err) { diag = { phase: 'harness', reason: 'harness_error', message: String((err as Error).message).slice(0, 500) }; }
    const result = judge(policy, ref, out, diag ? String(diag.message) : undefined);
    const actual = out && !out.incomplete ? await storeObservation(env.db, env.store, orgId, out) : out ? out.data.observation : null;
    await recordResult(env.db, { id: uuidv7(), orgId, runId, testCaseId: e.test_case_id, referenceOutputId: e.reference_output_id, outcome: result.outcome, actual, rawEqual: result.raw_equal, normalized: result.normalized, trace: result.normalization_trace, differences: result.differences, diagnostics: result.diagnostics, durationMs: Date.now() - t0 });
    done++;
  }
  const fin = await finalizeRun(env.db, orgId, runId, entries.length);
  await env.db.query(`INSERT INTO events(org_id,project_id,type,subject_type,subject_id,data) VALUES ($1,$2,'verification.finished','verification_run',$3,$4)`, [orgId, run.project_id, runId, JSON.stringify(fin ?? {})]);
  if (cancelled) throw new CancelledError();
}
