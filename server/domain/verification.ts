import type { Db } from '../db/db';
import { COMPARE_ENGINE_VERSION } from '@lb/compare';
import { moduleLanguage, targetEnvironment, TARGET_IDS } from '@lb/contracts';
import { digest } from './canonical';
import { getHeads } from './projects';

export interface BindingInput {
  source: { id: string; manifest_sha256: string }; scope: { id: string; sha256: string };
  module: { id: string; tree_sha256: string }; build: { id: string; image: string };
  case_set: { id: string; digest: string }; policy: { id: string; digest: string }; environment: { id: string; image: string };
}
/** Binding covers ids AND content digests plus the engine version (invariant 4). */
export const bindingDigest = (b: BindingInput) => digest({ ...b, compare_engine: COMPARE_ENGINE_VERSION });

export type StaleReason = 'module_revision_changed' | 'scope_reapproved' | 'case_set_changed' | 'policy_changed' | 'source_changed' | 'build_changed';

/** Computed on read, never stored (invariant 5). */
export async function appliesToCurrent(db: Db, orgId: string, projectId: string, runId: string) {
  const heads = await getHeads(db, orgId, projectId);
  const r = await db.query<{ source_revision_id: string; scope_revision_id: string; module_revision_id: string; case_set_revision_id: string; comparison_policy_id: string; build_result_id: string }>(
    'SELECT source_revision_id, scope_revision_id, module_revision_id, case_set_revision_id, comparison_policy_id, build_result_id FROM verification_runs WHERE id=$1 AND org_id=$2', [runId, orgId]);
  if (!r[0]) return null;
  const run = r[0], stale: StaleReason[] = [];
  if (run.module_revision_id !== heads.current_module_revision_id) stale.push('module_revision_changed');
  else {
    const latest = await db.query<{ id: string }>(`SELECT id FROM build_results WHERE module_revision_id=$1 AND status='succeeded' ORDER BY attempt DESC LIMIT 1`, [run.module_revision_id]);
    if (latest[0]?.id !== run.build_result_id) stale.push('build_changed');
  }
  if (run.scope_revision_id !== heads.approved_scope_revision_id) stale.push('scope_reapproved');
  if (run.case_set_revision_id !== heads.current_case_set_revision_id) stale.push('case_set_changed');
  if (run.comparison_policy_id !== heads.current_policy_id) stale.push('policy_changed');
  if (run.source_revision_id !== heads.current_source_revision_id) stale.push('source_changed');
  return { applies_to_current: stale.length === 0, stale_reasons: stale };
}

/** Insert-only: a duplicate delivery's write is a no-op (invariant 1). Returns true if this call inserted. */
export async function recordResult(db: Db, r: { id: string; orgId: string; runId: string; testCaseId: string; referenceOutputId: string | null; outcome: string; actual: unknown; rawEqual: boolean | null; normalized: boolean; trace: unknown; differences: unknown; diagnostics: unknown; durationMs: number }) {
  const x = await db.query(
    `INSERT INTO verification_results(id,org_id,verification_run_id,test_case_id,reference_output_id,outcome,actual,raw_equal,normalized,normalization_trace,differences,diagnostics,duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (verification_run_id, test_case_id) DO NOTHING RETURNING id`,
    [r.id, r.orgId, r.runId, r.testCaseId, r.referenceOutputId, r.outcome, JSON.stringify(r.actual), r.rawEqual, r.normalized, JSON.stringify(r.trace), JSON.stringify(r.differences), r.diagnostics === null ? null : JSON.stringify(r.diagnostics), r.durationMs]);
  return x.length === 1;
}

/** Finalize once: complete only if every case-set entry has a result. Summary is derived from results. */
export async function finalizeRun(db: Db, orgId: string, runId: string, expectedCases: number) {
  const rows = await db.query<{ outcome: string; n: number }>('SELECT outcome, count(*)::int AS n FROM verification_results WHERE verification_run_id=$1 AND org_id=$2 GROUP BY outcome', [runId, orgId]);
  const summary = { match: 0, difference: 0, couldnt_run: 0, needs_reference: 0 } as Record<string, number>;
  for (const r of rows) summary[r.outcome] = r.n;
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  const completeness = total === expectedCases ? 'complete' : 'partial';
  const u = await db.query('UPDATE verification_runs SET completeness=$3, summary=$4, finished_at=now() WHERE id=$1 AND org_id=$2 AND completeness IS NULL RETURNING id', [runId, orgId, completeness, JSON.stringify(summary)]);
  return u.length ? { completeness, summary } : null;
}

// ---------------- creating runs ----------------
import { uuidv7 } from '../db/ids';
import { enqueue } from '../jobs/queue';
import type { Ctx } from './ctx';
import { DomainError } from './errors';

export interface VerifyRequest { module_revision_id?: string; case_set_revision_id?: string; comparison_policy_id?: string; environment_id: string }

/** Binds exact revisions + content digests at enqueue time. An identical complete run is returned instead of re-running. */
export async function createVerificationRun(c: Ctx, projectId: string, req: VerifyRequest) {
  const h = await getHeads(c.db, c.orgId, projectId);
  const moduleId = req.module_revision_id ?? h.current_module_revision_id;
  const caseSetId = req.case_set_revision_id ?? h.current_case_set_revision_id;
  const policyId = req.comparison_policy_id ?? h.current_policy_id;
  if (!moduleId) throw new DomainError('module_required', 409, 'No module revision yet');
  if (!caseSetId) throw new DomainError('case_set_required', 409, 'No case set yet');
  if (!policyId) throw new DomainError('policy_required', 409, 'No comparison policy yet');
  if (!h.current_source_revision_id || !h.approved_scope_revision_id) throw new DomainError('scope_not_approved', 409);

  const one = async <T>(sql: string, p: unknown[]) => { const r = await c.db.query<T>(sql, p); if (!r[0]) throw new DomainError('not_found', 404); return r[0]; };
  const mod = await one<{ tree_sha256: string; scope_revision_id: string; target: string }>('SELECT tree_sha256, scope_revision_id, target FROM module_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [moduleId, c.orgId, projectId]);
  const build = (await c.db.query<{ id: string; build_image_digest: string }>(`SELECT id, build_image_digest FROM build_results WHERE module_revision_id=$1 AND org_id=$2 AND status='succeeded' ORDER BY attempt DESC LIMIT 1`, [moduleId, c.orgId]))[0];
  if (!build) throw new DomainError('build_required', 409, 'The module has no successful build; verification would only produce "couldn\'t run" results.');
  const scope = await one<{ document_sha256: string }>('SELECT document_sha256 FROM scope_revisions WHERE id=$1 AND org_id=$2', [mod.scope_revision_id, c.orgId]);
  const src = await one<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM source_revisions WHERE id=$1 AND org_id=$2', [h.current_source_revision_id, c.orgId]);
  const cs = await one<{ digest: string }>('SELECT digest FROM case_set_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [caseSetId, c.orgId, projectId]);
  const pol = await one<{ digest: string }>('SELECT digest FROM comparison_policies WHERE id=$1 AND org_id=$2 AND project_id=$3', [policyId, c.orgId, projectId]);
  const env = await one<{ image_digest: string; name: string }>("SELECT image_digest, name FROM execution_environments WHERE id=$1 AND role='replacement'", [req.environment_id]);
  const target = moduleLanguage(mod.target);
  const environmentTarget = TARGET_IDS.find(id => targetEnvironment(id) === env.name);
  if (!target || (environmentTarget && environmentTarget !== target)
    || (target !== 'typescript' && (environmentTarget !== target || env.image_digest !== build.build_image_digest))) {
    throw new DomainError('environment_target_mismatch', 409, 'Select the replacement environment for this module target.');
  }

  const binding: BindingInput = {
    source: { id: h.current_source_revision_id, manifest_sha256: src.manifest_sha256 }, scope: { id: mod.scope_revision_id, sha256: scope.document_sha256 },
    module: { id: moduleId, tree_sha256: mod.tree_sha256 }, build: { id: build.id, image: build.build_image_digest },
    case_set: { id: caseSetId, digest: cs.digest }, policy: { id: policyId, digest: pol.digest }, environment: { id: req.environment_id, image: env.image_digest },
  };
  const bd = bindingDigest(binding);
  const done = await c.db.query<{ id: string; job_id: string }>(`SELECT id, job_id FROM verification_runs WHERE org_id=$1 AND binding_digest=$2 AND completeness='complete'`, [c.orgId, bd]);
  if (done[0]) return { run_id: done[0].id, job_id: done[0].job_id, reused: true, binding_digest: bd };

  return c.db.tx(async (t) => {
    const active = await t.query<{ id: string; job_id: string }>(`SELECT r.id, r.job_id FROM verification_runs r JOIN jobs j ON j.id=r.job_id WHERE r.org_id=$1 AND r.binding_digest=$2 AND j.status IN ('queued','running')`, [c.orgId, bd]);
    if (active[0]) return { run_id: active[0].id, job_id: active[0].job_id, reused: true, binding_digest: bd };
    const runId = uuidv7();
    const job = await enqueue(t, { orgId: c.orgId, projectId, kind: 'verify', subjectType: 'verification_run', subjectId: runId, dedupeKey: `verify:${bd}` });
    await t.query(`INSERT INTO verification_runs(id,org_id,project_id,job_id,source_revision_id,scope_revision_id,module_revision_id,build_result_id,case_set_revision_id,comparison_policy_id,replacement_env_id,binding,binding_digest,created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [runId, c.orgId, projectId, job.id, binding.source.id, binding.scope.id, moduleId, build.id, caseSetId, policyId, req.environment_id, JSON.stringify(binding), bd, c.userId]);
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'verification.started','verification_run',$4)`, [c.orgId, projectId, c.userId, runId]);
    return { run_id: runId, job_id: job.id, reused: false, binding_digest: bd };
  });
}
