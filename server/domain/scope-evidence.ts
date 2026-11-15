import type { Db } from '../db/db';
import { DomainError } from './errors';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Draft and sealed revisions validate against the same source and organization. Older runs of that source remain citable. */
export async function validateScopeEvidence(db: Db, orgId: string, sourceId: string | null, document: unknown) {
  const references: { id: string; path: string }[] = [];
  const scope = document as Record<string, unknown> | null;
  for (const section of ['behaviors', 'dependencies'] as const) {
    const entries = scope?.[section];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      if (!Array.isArray(entry?.evidence)) return;
      entry.evidence.forEach((id: unknown, j: number) => {
        references.push({ id: typeof id === 'string' ? id.toLowerCase() : '', path: `${section}[${i}].evidence[${j}]` });
      });
    });
  }
  if (!references.length) return;
  const ids = [...new Set(references.map(ref => ref.id).filter(id => uuid.test(id)))];
  const rows = sourceId && ids.length ? await db.query<{ id: string }>(
    'SELECT id FROM findings WHERE org_id=$1 AND source_revision_id=$2 AND id=ANY($3::uuid[])',
    [orgId, sourceId, ids],
  ) : [];
  const known = new Set(rows.map(row => row.id));
  const errors = references.filter(ref => !known.has(ref.id)).map(ref => ({ path: ref.path, code: 'unknown_finding' }));
  if (errors.length) throw new DomainError('unknown_finding', 422, 'Cite findings from the current source revision.', undefined, errors);
}
