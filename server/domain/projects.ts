import type { Db } from '../db/db';
import { uuidv7 } from '../db/ids';
import { digest } from './canonical';
import { DomainError } from './errors';
import { validateScopeEvidence } from './scope-evidence';

export interface Heads {
  current_source_revision_id: string | null; approved_scope_revision_id: string | null; current_module_revision_id: string | null;
  current_case_set_revision_id: string | null; current_policy_id: string | null; heads_version: number;
}
export type HeadName = Exclude<keyof Heads, 'heads_version'>;
const HEAD_COLUMNS: HeadName[] = ['current_source_revision_id', 'approved_scope_revision_id', 'current_module_revision_id', 'current_case_set_revision_id', 'current_policy_id'];

export async function getHeads(db: Db, orgId: string, projectId: string): Promise<Heads> {
  const r = await db.query<Heads>(`SELECT ${HEAD_COLUMNS.join(',')}, heads_version FROM projects WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [projectId, orgId]);
  if (!r[0]) throw new DomainError('not_found', 404); // cross-org access is 404, never 403
  return r[0];
}

/** Compare-and-swap head move. Fails with 409 if another writer moved any head since `expectedVersion`. */
export async function moveHead(db: Db, orgId: string, projectId: string, head: HeadName, to: string, expectedVersion: number): Promise<number> {
  if (!HEAD_COLUMNS.includes(head)) throw new Error('bad head');
  const r = await db.query<{ heads_version: number }>(
    `UPDATE projects SET ${head}=$3, heads_version=heads_version+1 WHERE id=$1 AND org_id=$2 AND heads_version=$4 AND deleted_at IS NULL RETURNING heads_version`,
    [projectId, orgId, to, expectedVersion]);
  if (!r[0]) throw new DomainError('heads_conflict', 409, 'Project heads changed; reload and retry');
  return r[0].heads_version;
}

/** Next per-project revision number for a revision table (callers rely on UNIQUE(project_id, number) to catch races). */
export async function nextNumber(db: Db, table: 'source_revisions' | 'scope_revisions' | 'module_revisions' | 'case_set_revisions' | 'comparison_policies', projectId: string) {
  const r = await db.query<{ n: number }>(`SELECT COALESCE(MAX(number),0)+1 AS n FROM ${table} WHERE project_id=$1`, [projectId]);
  return Number(r[0].n);
}

// ---------------- scope: draft -> revision -> decision ----------------
/**
 * `baseRevisionId` records which sealed revision the draft was seeded from (lineage for the next revision's `parent_id`).
 * `undefined` keeps the draft's current base; `null` clears it.
 */
export async function putScopeDraft(db: Db, orgId: string, projectId: string, document: unknown, ifMatchVersion: number | null, userId: string | null, baseRevisionId?: string | null) {
  const heads = await getHeads(db, orgId, projectId);
  await validateScopeEvidence(db, orgId, heads.current_source_revision_id, document);
  if (baseRevisionId) {
    const b = await db.query('SELECT 1 FROM scope_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [baseRevisionId, orgId, projectId]);
    if (!b.length) throw new DomainError('not_found', 404, 'base revision');
  }
  const cur = await db.query<{ version: number }>('SELECT version FROM scope_drafts WHERE project_id=$1 AND org_id=$2', [projectId, orgId]);
  if (!cur[0]) {
    if (ifMatchVersion !== null && ifMatchVersion !== 0) throw new DomainError('precondition_failed', 412);
    await db.query('INSERT INTO scope_drafts(project_id,org_id,base_revision_id,document,version,updated_by) VALUES ($1,$2,$3,$4,1,$5)', [projectId, orgId, baseRevisionId ?? null, JSON.stringify(document), userId]);
    return 1;
  }
  const r = await db.query<{ version: number }>(
    `UPDATE scope_drafts SET document=$3, version=version+1, updated_by=$5, updated_at=now(), base_revision_id=CASE WHEN $6::boolean THEN $7::uuid ELSE base_revision_id END WHERE project_id=$1 AND org_id=$2 AND version=$4 RETURNING version`,
    [projectId, orgId, JSON.stringify(document), ifMatchVersion, userId, baseRevisionId !== undefined, baseRevisionId ?? null]);
  if (!r[0]) throw new DomainError('precondition_failed', 412, `Draft is at version ${cur[0].version}`);
  return r[0].version;
}

export async function createScopeRevision(db: Db, orgId: string, projectId: string, fromDraftVersion: number, userId: string | null) {
  return db.tx(async (t) => {
    const heads = await getHeads(t, orgId, projectId);
    if (!heads.current_source_revision_id) throw new DomainError('source_required', 409);
    const d = await t.query<{ document: unknown; version: number; base_revision_id: string | null }>('SELECT document, version, base_revision_id FROM scope_drafts WHERE project_id=$1 AND org_id=$2', [projectId, orgId]);
    if (!d[0] || d[0].version !== fromDraftVersion) throw new DomainError('precondition_failed', 412);
    await validateScopeEvidence(t, orgId, heads.current_source_revision_id, d[0].document);
    const id = uuidv7(), number = await nextNumber(t, 'scope_revisions', projectId), sha = digest(d[0].document);
    await t.query(`INSERT INTO scope_revisions(id,org_id,project_id,number,parent_id,source_revision_id,document,document_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, orgId, projectId, number, d[0].base_revision_id, heads.current_source_revision_id, JSON.stringify(d[0].document), sha, userId]);
    // The draft now equals this revision; the next revision descends from it.
    await t.query('UPDATE scope_drafts SET base_revision_id=$3 WHERE project_id=$1 AND org_id=$2', [projectId, orgId, id]);
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'scope_revision.created','scope_revision',$4)`, [orgId, projectId, userId, id]);
    return { id, number, parent_id: d[0].base_revision_id, document_sha256: sha };
  });
}

/** One decision per revision; approval moves the head by CAS. Digest must match what the user saw. */
export async function decideScope(db: Db, orgId: string, projectId: string, scopeId: string, decision: 'approved' | 'rejected', documentSha: string, userId: string, comment?: string) {
  return db.tx(async (t) => {
    const s = await t.query<{ document_sha256: string; document: { behaviors?: unknown }; source_revision_id: string }>('SELECT document_sha256, document, source_revision_id FROM scope_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [scopeId, orgId, projectId]);
    if (!s[0]) throw new DomainError('not_found', 404);
    if (s[0].document_sha256 !== documentSha) throw new DomainError('digest_mismatch', 409);
    if (decision === 'rejected' && !comment?.trim()) throw new DomainError('comment_required', 422, 'Say why the scope is rejected.');
    if (decision === 'approved') {
      if (!Array.isArray(s[0].document.behaviors) || !s[0].document.behaviors.length) throw new DomainError('scope_empty', 422, 'Add at least one behavior to modernize before approving.');
      const cur = await getHeads(t, orgId, projectId);
      if (s[0].source_revision_id !== cur.current_source_revision_id) throw new DomainError('scope_source_changed', 409, 'This scope was written for an earlier source revision. Create a new revision from the current source.');
    }
    const ins = await t.query(`INSERT INTO approvals(id,org_id,scope_revision_id,document_sha256,decision,decided_by,comment) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (scope_revision_id) DO NOTHING RETURNING id`,
      [uuidv7(), orgId, scopeId, documentSha, decision, userId, comment ?? null]);
    if (!ins.length) throw new DomainError('already_decided', 409);
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id,data) VALUES ($1,$2,$3,$4,'scope_revision',$5,$6)`, [orgId, projectId, userId, `scope_revision.${decision}`, scopeId, JSON.stringify({ comment: comment ?? null })]);
    const heads = await getHeads(t, orgId, projectId);
    if (decision === 'rejected') return { decision, approved_scope_revision_id: heads.approved_scope_revision_id };
    const v = await moveHead(t, orgId, projectId, 'approved_scope_revision_id', scopeId, heads.heads_version);
    return { decision, approved_scope_revision_id: scopeId, heads_version: v };
  });
}

/** Invariant 3: a module revision may only be created against an approved scope revision of the same project. */
export async function assertScopeApproved(db: Db, orgId: string, projectId: string, scopeId: string) {
  const r = await db.query(`SELECT 1 FROM approvals a JOIN scope_revisions s ON s.id=a.scope_revision_id WHERE a.scope_revision_id=$1 AND a.org_id=$2 AND s.project_id=$3 AND a.decision='approved'`, [scopeId, orgId, projectId]);
  if (!r.length) throw new DomainError('scope_not_approved', 409);
}
