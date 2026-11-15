/** Content-addressed blob storage. Keys are derived server-side from (org, sha256); clients never supply keys (§2.3). */
export interface PresignedPut { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: Date }

export interface BlobStore {
  /** Staging upload target. The sha256 is enforced by storage where supported (x-amz-checksum-sha256). */
  presignPut(orgId: string, uploadId: string, sha256: string, size: number): Promise<PresignedPut>;
  /** Size of the staged object, or null if absent. */
  statStaged(orgId: string, uploadId: string): Promise<{ size: number } | null>;
  /** Move a staged object into content-addressed storage after the server recomputed its hash. */
  promote(orgId: string, uploadId: string, sha256: string): Promise<{ key: string }>;
  put(orgId: string, data: Buffer): Promise<{ sha256: string; size: number; key: string }>;
  get(orgId: string, sha256: string): Promise<Buffer>;
  getStaged(orgId: string, uploadId: string): Promise<Buffer>;
  presignGet(orgId: string, sha256: string, filename: string): Promise<string>;
  /** Removes a content-addressed object. Idempotent: deleting a missing object succeeds. Used only by purge. */
  delete(orgId: string, sha256: string): Promise<void>;
  /** Removes a staging object. Idempotent. */
  deleteStaged(orgId: string, uploadId: string): Promise<void>;
}

export const blobKey = (org: string, sha: string) => `orgs/${org}/blobs/sha256/${sha.slice(0, 2)}/${sha}`;
export const stagingKey = (org: string, upload: string) => `orgs/${org}/staging/${upload}`;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
export function assertSafe(org: string, id: string, isSha: boolean) {
  if (!UUID.test(org) || !(isSha ? SHA : UUID).test(id)) throw new Error('invalid storage identifier');
}
