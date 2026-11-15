import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { getHeads } from './projects';

type Status = 'pending' | 'approved' | 'rejected';
interface Row {
  id: string; project_id: string; number: number; parent_id: string | null; source_revision_id: string; document: Record<string, unknown>;
  document_sha256: string; created_by: string | null; created_at: string;
  decision: 'approved' | 'rejected' | null; decided_by: string | null; decided_at: string | null; comment: string | null;
}
const COLUMNS = `s.id, s.project_id, s.number, s.parent_id, s.source_revision_id, s.document, s.document_sha256, s.created_by, s.created_at,
  a.decision, a.decided_by, a.created_at AS decided_at, a.comment`;
const FROM = 'FROM scope_revisions s LEFT JOIN approvals a ON a.scope_revision_id=s.id AND a.org_id=s.org_id';
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** Finding ids cited by behaviors and dependencies, in document order and de-duplicated. */
export function citedFindingIds(document: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const section of ['behaviors', 'dependencies']) {
    for (const entry of list(document?.[section])) for (const id of list((entry as { evidence?: unknown })?.evidence)) if (typeof id === 'string') ids.add(id.toLowerCase());
  }
  return [...ids];
}

function summarize(r: Row, heads: { approved_scope_revision_id: string | null; current_source_revision_id: string | null }) {
  const status: Status = r.decision ?? 'pending';
  return {
    id: r.id, number: Number(r.number), parent_id: r.parent_id, source_revision_id: r.source_revision_id, document_sha256: r.document_sha256,
    created_by: r.created_by, created_at: r.created_at, status,
    is_approved_head: heads.approved_scope_revision_id === r.id,
    source_is_current: heads.current_source_revision_id === r.source_revision_id,
    counts: {
      behaviors: list(r.document?.behaviors).length, assumptions: list(r.document?.assumptions).length, decisions: list(r.document?.decisions).length,
      open_questions: list(r.document?.open_questions).filter((q) => (q as { status?: string })?.status !== 'resolved').length,
    },
  };
}

export async function listScopeRevisions(c: Ctx, projectId: string) {
  const heads = await getHeads(c.db, c.orgId, projectId);
  const rows = await c.db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE s.project_id=$1 AND s.org_id=$2 ORDER BY s.number DESC LIMIT 200`, [projectId, c.orgId]);
  return { items: rows.map((r) => summarize(r, heads)), approved_scope_revision_id: heads.approved_scope_revision_id };
}

/**
 * One sealed revision with its decision and every cited finding hydrated. This is the approved-scope input for code generation (S4):
 * the document alone is not enough, because a generator needs the evidence the behaviors rest on.
 */
export async function getScopeRevision(c: Ctx, scopeId: string) {
  const r = (await c.db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE s.id=$1 AND s.org_id=$2`, [scopeId, c.orgId]))[0];
  if (!r) throw new DomainError('not_found', 404);
  const heads = await getHeads(c.db, c.orgId, r.project_id);
  const ids = citedFindingIds(r.document).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  const findings = ids.length ? await c.db.query<{ id: string; kind: string; name: string | null; address: string | null; authority: string; artifact_path: string; artifact_sha256: string; provider_evidence_id: string; analysis_run_id: string; source_revision_id: string }>(
    'SELECT id, kind, name, address, authority, artifact_path, artifact_sha256, provider_evidence_id, analysis_run_id, source_revision_id FROM findings WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [c.orgId, ids]) : [];
  return {
    ...summarize(r, heads), document: r.document,
    decision: r.decision ? { decision: r.decision, decided_by: r.decided_by, decided_at: r.decided_at, comment: r.comment } : null,
    evidence: findings,
  };
}
