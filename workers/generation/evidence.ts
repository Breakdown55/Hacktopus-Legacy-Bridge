import { citedFindingIds } from '../../server/domain/scope';
import type { Db } from '../../server/db/db';
import type { BlobStore } from '../../server/storage/blobstore';
import { EVIDENCE_LIMITS, type EvidenceItem } from './provider';

interface Row { id: string; kind: string; name: string | null; address: string | null; attributes: unknown; location: unknown; artifact_sha256: string; content_blob_sha256: string | null }
const COLS = 'id, kind, name, address, attributes, location, artifact_sha256, content_blob_sha256';

/**
 * Evidence the supervisor chooses for a generation request: the findings the approved scope cites, plus pseudocode for any cited function.
 * Excerpts are capped per item and in total. Everything here comes from an untrusted binary and is passed to the model as data.
 */
export async function buildEvidence(db: Db, store: BlobStore, orgId: string, sourceId: string, document: Record<string, unknown>): Promise<EvidenceItem[]> {
  const ids = citedFindingIds(document).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (!ids.length) return [];
  const cited = await db.query<Row>(`SELECT ${COLS} FROM findings WHERE org_id=$1 AND source_revision_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`, [orgId, sourceId, ids]);
  const addresses = cited.filter((r) => r.kind === 'function' && r.address).map((r) => r.address);
  const related = addresses.length ? await db.query<Row>(`SELECT ${COLS} FROM findings WHERE org_id=$1 AND source_revision_id=$2 AND kind='pseudocode' AND address=ANY($3::text[]) AND NOT (id=ANY($4::uuid[])) ORDER BY id`, [orgId, sourceId, addresses, ids]) : [];
  const out: EvidenceItem[] = [];
  let total = 0;
  for (const r of [...cited, ...related]) {
    let excerpt = r.content_blob_sha256 ? (await store.get(orgId, r.content_blob_sha256)).toString('utf8') : JSON.stringify(r.attributes ?? {});
    excerpt = excerpt.slice(0, EVIDENCE_LIMITS.perItem);
    if (total + excerpt.length > EVIDENCE_LIMITS.total) break;
    total += excerpt.length;
    out.push({ findingId: r.id, kind: r.kind, name: r.name, address: r.address, artifactSha256: r.artifact_sha256, location: r.location, excerpt });
  }
  return out;
}
