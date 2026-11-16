import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { getHeads } from './projects';
import { appliesToCurrent } from './verification';
import { getSourceStatus } from './sources';
import { encodeCursor, decodeCursor } from '../http/handler';

/** Progress is derived from backend state, never stored (§5 UI integration contract). */
export async function getProgress(c: Ctx, projectId: string) {
  const h = await getHeads(c.db, c.orgId, projectId);
  const needs: { step: string; code: string; count?: number }[] = [];
  const steps: boolean[] = [false, false, false, false, false];
  if (h.current_source_revision_id) {
    const st = await getSourceStatus(c, h.current_source_revision_id);
    steps[0] = st.eligibility.analysis.status === 'eligible' || st.eligibility.analysis.status === 'partial';
    if (!steps[0]) needs.push({ step: 'import', code: st.eligibility.analysis.status === 'unknown' ? 'analysis_pending' : 'analysis_ineligible' });
  } else needs.push({ step: 'import', code: 'source_required' });
  // Scope approval counts only for the source revision it was written against; a re-import leaves the old approval behind.
  let scopeSource: string | null = null;
  if (h.approved_scope_revision_id) scopeSource = (await c.db.query<{ source_revision_id: string }>('SELECT source_revision_id FROM scope_revisions WHERE id=$1 AND org_id=$2', [h.approved_scope_revision_id, c.orgId]))[0]?.source_revision_id ?? null;
  steps[1] = !!h.approved_scope_revision_id && scopeSource === h.current_source_revision_id;
  if (steps[0] && !steps[1]) needs.push({ step: 'select', code: h.approved_scope_revision_id ? 'scope_source_changed' : 'scope_approval_required' });
  if (h.current_module_revision_id) {
    const m = (await c.db.query<{ scope_revision_id: string }>('SELECT scope_revision_id FROM module_revisions WHERE id=$1 AND org_id=$2', [h.current_module_revision_id, c.orgId]))[0];
    const b = await c.db.query('SELECT 1 FROM build_results WHERE module_revision_id=$1 AND status=$2 LIMIT 1', [h.current_module_revision_id, 'succeeded']);
    // A module built against an earlier scope revision does not satisfy the approved one.
    steps[2] = steps[1] && b.length > 0 && m?.scope_revision_id === h.approved_scope_revision_id;
    if (steps[1] && m?.scope_revision_id !== h.approved_scope_revision_id) needs.push({ step: 'modernize', code: 'module_scope_outdated' });
    else if (!b.length) needs.push({ step: 'modernize', code: 'build_not_succeeded' });
  } else if (steps[1]) needs.push({ step: 'modernize', code: 'module_required' });
  if (h.current_case_set_revision_id) {
    const cs = (await c.db.query<{ entries: { reference_output_id: string | null }[] }>('SELECT entries FROM case_set_revisions WHERE id=$1', [h.current_case_set_revision_id]))[0];
    const missing = cs.entries.filter((e) => !e.reference_output_id).length;
    if (missing) needs.push({ step: 'verify', code: 'needs_reference', count: missing });
  }
  const run = (await c.db.query<{ id: string; completeness: string }>(`SELECT id, completeness FROM verification_runs WHERE project_id=$1 AND org_id=$2 AND completeness IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 5`, [projectId, c.orgId]));
  let currentRun: string | null = null;
  for (const r of run) {
    const a = await appliesToCurrent(c.db, c.orgId, projectId, r.id);
    if (a?.applies_to_current) { currentRun = r.id; break; }
  }
  steps[3] = currentRun !== null;
  if (steps[2] && !steps[3]) needs.push({ step: 'verify', code: 'verification_required' });
  const ex = currentRun
    ? await c.db.query('SELECT 1 FROM export_packages WHERE project_id=$1 AND org_id=$2 AND verification_run_id=$3 AND package_blob_sha256 IS NOT NULL AND expires_at>now() LIMIT 1', [projectId, c.orgId, currentRun])
    : [];
  steps[4] = ex.length > 0;
  const completed = steps.findIndex((s) => !s);
  const done = completed === -1 ? 5 : completed;
  return { stage: ['import', 'select', 'modernize', 'verify', 'export'][Math.min(done, 4)], completed_steps: done, needs_input: needs };
}

/**
 * When someone last changed a project: the newest of its creation and anything a person added to it (an upload, an edit to the
 * selection, a module, a test case they wrote, a policy, a verification or an export, or an action recorded in the activity log).
 * Work the system does by itself (analysis, naming on page load, template cases) does not count.
 */
const LAST_ACTIVITY = `GREATEST(p.created_at, COALESCE((SELECT max(t) FROM (
  SELECT created_at AS t FROM source_revisions WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT updated_at FROM scope_drafts WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM scope_revisions WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM module_revisions WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM test_cases WHERE org_id=p.org_id AND project_id=p.id AND origin <> 'template'
  UNION ALL SELECT created_at FROM case_set_revisions WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM comparison_policies WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM verification_runs WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM export_packages WHERE org_id=p.org_id AND project_id=p.id
  UNION ALL SELECT created_at FROM events WHERE org_id=p.org_id AND project_id=p.id AND actor_id IS NOT NULL AND type <> 'function_name.requested'
) x), p.created_at))`;

export async function getProject(c: Ctx, projectId: string) {
  const p = (await c.db.query<{ id: string; name: string; description: string; objectives: string; created_at: string; target_language: string; last_activity_at: string }>(`SELECT p.id, p.name, p.description, p.objectives, p.created_at, p.target_language, ${LAST_ACTIVITY} AS last_activity_at FROM projects p WHERE p.id=$1 AND p.org_id=$2 AND p.deleted_at IS NULL`, [projectId, c.orgId]))[0];
  if (!p) throw new DomainError('not_found', 404);
  const heads = await getHeads(c.db, c.orgId, projectId);
  return { ...p, progress: await getProgress(c, projectId), heads };
}

export async function listProjects(c: Ctx, limit: number, cursor: string | null) {
  const cur = decodeCursor(cursor);
  // Most recently changed first. The cursor carries the activity time as text so no precision is lost between pages.
  const rows = await c.db.query<{ id: string; activity: string }>(
    `SELECT id, activity FROM (SELECT p.id, ${LAST_ACTIVITY} AS at, (${LAST_ACTIVITY})::text AS activity FROM projects p WHERE p.org_id=$1 AND p.deleted_at IS NULL) s
     WHERE ($2::timestamptz IS NULL OR (at, id) < ($2::timestamptz, $3::uuid)) ORDER BY at DESC, id DESC LIMIT $4`,
    [c.orgId, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1]);
  const page = rows.slice(0, limit);
  return { items: await Promise.all(page.map((r) => getProject(c, r.id))), next_cursor: rows.length > limit ? encodeCursor(page[limit - 1].activity, page[limit - 1].id) : null };
}

export async function getJob(c: Ctx, jobId: string) {
  const j = (await c.db.query<{ id: string; kind: string; status: string; attempt: number; progress: unknown; error: unknown }>('SELECT id, kind, status, attempt, progress, error FROM jobs WHERE id=$1 AND org_id=$2', [jobId, c.orgId]))[0];
  if (!j) throw new DomainError('not_found', 404);
  return j;
}

export async function getActivity(c: Ctx, projectId: string, after: number, limit: number) {
  await getHeads(c.db, c.orgId, projectId);
  const items = await c.db.query<{ id: string; type: string; subject_type: string | null; subject_id: string | null; data: unknown; created_at: string }>(
    'SELECT id::text AS id, type, subject_type, subject_id, data, created_at FROM events WHERE org_id=$1 AND project_id=$2 AND events.id > $3 ORDER BY events.id LIMIT $4', [c.orgId, projectId, after, limit]);
  const jobs = await c.db.query<{ id: string; kind: string; status: string; progress: unknown }>(`SELECT id, kind, status, progress FROM jobs WHERE org_id=$1 AND project_id=$2 AND status IN ('queued','running')`, [c.orgId, projectId]);
  return { items: items.map((e) => ({ id: `evt_${e.id}`, type: e.type, subject: { type: e.subject_type, id: e.subject_id }, data: e.data, created_at: e.created_at })), next_cursor: items.length ? `evt_${items[items.length - 1].id}` : `evt_${after}`, active_jobs: jobs };
}

export async function getVerificationRun(c: Ctx, runId: string) {
  const r = (await c.db.query<any>('SELECT id, project_id, job_id, binding, binding_digest, completeness, summary, created_at, finished_at FROM verification_runs WHERE id=$1 AND org_id=$2', [runId, c.orgId]))[0];
  if (!r) throw new DomainError('not_found', 404);
  const job = (await c.db.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [r.job_id]))[0];
  const applies = await appliesToCurrent(c.db, c.orgId, r.project_id, runId);
  const limitations: string[] = [];
  if (r.summary?.needs_reference) limitations.push(`${r.summary.needs_reference} cases have no independent reference`);
  limitations.push('filesystem observed only under working directory');
  return { id: r.id, job_status: job?.status ?? null, completeness: r.completeness, summary: r.summary, binding: r.binding, binding_digest: r.binding_digest, ...applies, limitations };
}

export async function listResults(c: Ctx, runId: string, outcome: string | null, limit: number, cursor: string | null) {
  const run = await c.db.query('SELECT 1 FROM verification_runs WHERE id=$1 AND org_id=$2', [runId, c.orgId]);
  if (!run.length) throw new DomainError('not_found', 404);
  const after = cursor ?? '00000000-0000-0000-0000-000000000000';
  const rows = await c.db.query<{ id: string; test_case_id: string; outcome: string; raw_equal: boolean | null; normalized: boolean; differences: unknown; diagnostics: unknown }>(
    'SELECT id, test_case_id, outcome, raw_equal, normalized, differences, diagnostics FROM verification_results WHERE verification_run_id=$1 AND org_id=$2 AND ($3::text IS NULL OR outcome=$3) AND id > $4 ORDER BY id LIMIT $5', [runId, c.orgId, outcome, after, limit + 1]);
  const page = rows.slice(0, limit);
  return { items: page, next_cursor: rows.length > limit ? page[page.length - 1].id : null };
}

/** One verification result with everything the diff view needs. Org-scoped: another org's id is a 404. */
export async function getResult(c: Ctx, resultId: string) {
  const r = (await c.db.query<Record<string, unknown>>(
    `SELECT id, verification_run_id, test_case_id, reference_output_id, outcome, raw_equal, normalized, normalization_trace, differences, diagnostics, actual, duration_ms
     FROM verification_results WHERE id=$1 AND org_id=$2`, [resultId, c.orgId]))[0];
  if (!r) throw new DomainError('not_found', 404);
  const ref = r.reference_output_id
    ? (await c.db.query<{ provenance: string; deterministic: boolean | null; observation: unknown }>('SELECT provenance, deterministic, observation FROM reference_outputs WHERE id=$1 AND org_id=$2', [r.reference_output_id, c.orgId]))[0]
    : undefined;
  const digests = (obs: any) => obs ? { stdout: obs.stdout?.sha256 ?? null, stderr: obs.stderr?.sha256 ?? null, exit: obs.exit ?? null } : null;
  return { ...r, reference: ref ? { provenance: ref.provenance, deterministic: ref.deterministic, digests: digests(ref.observation) } : null, actual_digests: digests(r.actual) };
}

export async function getModule(c: Ctx, moduleId: string) {
  const m = (await c.db.query<any>('SELECT id, project_id, number, parent_id, scope_revision_id, origin, target, tree_sha256, file_manifest, untranslated, generator FROM module_revisions WHERE id=$1 AND org_id=$2', [moduleId, c.orgId]))[0];
  if (!m) throw new DomainError('not_found', 404);
  const b = (await c.db.query<any>('SELECT attempt, status, diagnostics FROM build_results WHERE module_revision_id=$1 ORDER BY attempt DESC LIMIT 1', [moduleId]))[0];
  const active = (await c.db.query<{ status: string }>(`SELECT status FROM jobs WHERE kind='build' AND subject_id=$1 AND status IN ('queued','running')`, [moduleId]))[0];
  return { ...m, build: { status: active ? 'building' : b?.status ?? 'not_built', attempt: b?.attempt ?? null, diagnostics: b?.diagnostics ?? [] } };
}

export async function listBuilds(c: Ctx, moduleId: string) {
  const ok = await c.db.query('SELECT 1 FROM module_revisions WHERE id=$1 AND org_id=$2', [moduleId, c.orgId]);
  if (!ok.length) throw new DomainError('not_found', 404);
  return c.db.query('SELECT attempt, status, diagnostics, build_image_digest, toolchain FROM build_results WHERE module_revision_id=$1 AND org_id=$2 ORDER BY attempt', [moduleId, c.orgId]);
}
