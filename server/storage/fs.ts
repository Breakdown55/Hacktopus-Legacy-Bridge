import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertSafe, blobKey, stagingKey, type BlobStore } from './blobstore';

/** Local filesystem store for tests and dev. "Presigned" URLs are file:// paths the test writes to directly. */
export class FsBlobStore implements BlobStore {
  constructor(private root: string) {}
  private p(key: string) { return join(this.root, key); }
  async presignPut(org: string, upload: string, sha256: string, _size?: number) {
    assertSafe(org, upload, false);
    return { method: 'PUT' as const, url: `file://${this.p(stagingKey(org, upload))}`, headers: { 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') }, expiresAt: new Date(Date.now() + 600_000) };
  }
  async statStaged(org: string, upload: string) {
    assertSafe(org, upload, false);
    const f = this.p(stagingKey(org, upload));
    return existsSync(f) ? { size: statSync(f).size } : null;
  }
  async promote(org: string, upload: string, sha: string) {
    assertSafe(org, upload, false); assertSafe(org, sha, true);
    const key = blobKey(org, sha);
    mkdirSync(dirname(this.p(key)), { recursive: true });
    renameSync(this.p(stagingKey(org, upload)), this.p(key));
    return { key };
  }
  async put(org: string, data: Buffer) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    assertSafe(org, sha256, true);
    const key = blobKey(org, sha256);
    mkdirSync(dirname(this.p(key)), { recursive: true });
    writeFileSync(this.p(key), data);
    return { sha256, size: data.length, key };
  }
  async get(org: string, sha: string) { assertSafe(org, sha, true); return readFileSync(this.p(blobKey(org, sha))); }
  async getStaged(org: string, upload: string) { assertSafe(org, upload, false); return readFileSync(this.p(stagingKey(org, upload))); }
  async presignGet(org: string, sha: string) { assertSafe(org, sha, true); return `file://${this.p(blobKey(org, sha))}`; }
  async delete(org: string, sha: string) { assertSafe(org, sha, true); rmSync(this.p(blobKey(org, sha)), { force: true }); }
  async deleteStaged(org: string, upload: string) { assertSafe(org, upload, false); rmSync(this.p(stagingKey(org, upload)), { force: true }); }
}
