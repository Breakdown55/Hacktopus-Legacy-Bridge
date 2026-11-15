import { enqueue } from '../jobs/queue';
import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { assertGenerationQuota } from './quotas';
import { assertScopeApproved, getHeads } from './projects';

export interface GenerationInput { scope_revision_id: string; parent_id?: string | null; instructions?: string }

export async function functionNamingSource(c: Ctx, projectId: string, findingId: string) {
  const heads = await getHeads(c.db, c.orgId, projectId);
  const [finding] = await c.db.query<{ source_revision_id: string }>(
    "SELECT source_revision_id FROM findings WHERE org_id=$1 AND id=$2 AND source_revision_id=$3 AND kind='function'",
    [c.orgId, findingId, heads.current_source_revision_id],
  );
  if (!finding) throw new DomainError('not_found', 404);
  const [org] = await c.db.query<{ external_model_allowed: boolean }>('SELECT external_model_allowed FROM organizations WHERE id=$1', [c.orgId]);
  if (!org?.external_model_allowed) throw new DomainError('external_model_not_allowed', 409,
    'Your organization has disabled sending evidence to AI. You can enter a label manually.');
  return finding.source_revision_id;
}

export async function requestFunctionName(c: Ctx, projectId: string, findingId: string) {
  await functionNamingSource(c, projectId, findingId);
  await assertGenerationQuota(c, 'function_name.requested');
  const job = await c.db.tx(async t => {
    const j = await enqueue(t, {
      orgId: c.orgId, projectId, kind: 'suggest_function_name', subjectType: 'finding', subjectId: findingId,
      dedupeKey: 'suggest_function_name:' + findingId, maxAttempts: 1,
    });
    if (!j.deduped) await t.query(
      "INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'function_name.requested','finding',$4)",
      [c.orgId, projectId, c.userId, findingId],
    );
    return j;
  });
  return { job_id: job.id };
}

/**
 * Queues a generation job. Gates: the scope must be the approved head (generation never runs from a draft or an older approval),
 * and the organization must allow sending evidence to an external model (plan §6.3 data handling).
 */
export async function requestGeneration(c: Ctx, projectId: string, i: GenerationInput) {
  await assertGenerationQuota(c);
  const heads = await getHeads(c.db, c.orgId, projectId);
  await assertScopeApproved(c.db, c.orgId, projectId, i.scope_revision_id);
  if (heads.approved_scope_revision_id !== i.scope_revision_id) throw new DomainError('scope_not_current', 409, 'Generate from the currently approved scope revision.');
  const org = (await c.db.query<{ external_model_allowed: boolean }>('SELECT external_model_allowed FROM organizations WHERE id=$1', [c.orgId]))[0];
  if (!org?.external_model_allowed) throw new DomainError('external_model_not_allowed', 409, 'This organization has not allowed sending scope and evidence to an external model. Upload or edit the module instead.', { kind: 'enable_setting', setting: 'external_model_allowed', role_required: 'admin' });
  if (i.parent_id) {
    const p = await c.db.query('SELECT 1 FROM module_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [i.parent_id, c.orgId, projectId]);
    if (!p.length) throw new DomainError('not_found', 404, 'module revision');
  }
  const job = await c.db.tx(async (t) => {
    const j = await enqueue(t, { orgId: c.orgId, projectId, kind: 'generate', subjectType: 'scope_revision', subjectId: i.scope_revision_id, payload: { scope_revision_id: i.scope_revision_id, parent_id: i.parent_id ?? null, instructions: i.instructions ?? '', user_id: c.userId }, dedupeKey: `generate:${i.scope_revision_id}:${i.parent_id ?? 'new'}`, maxAttempts: 2 });
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'generation.requested','scope_revision',$4)`, [c.orgId, projectId, c.userId, i.scope_revision_id]);
    return j;
  });
  return { job_id: job.id };
}
