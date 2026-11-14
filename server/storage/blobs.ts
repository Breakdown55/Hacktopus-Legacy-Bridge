import type { Db } from '../db/db';
import type { BlobStore } from './blobstore';

/** Stores bytes content-addressed and records the (org, sha256) row, so every stored object is known to the database. */
export async function putBlob(db: Db, store: BlobStore, orgId: string, data: Buffer, mediaType = 'application/octet-stream') {
  const b = await store.put(orgId, data);
  await db.query('INSERT INTO blobs(org_id,sha256,size_bytes,storage_key,media_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [orgId, b.sha256, b.size, b.key, mediaType]);
  return b;
}
