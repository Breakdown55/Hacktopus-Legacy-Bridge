import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { assertSafe, blobKey, stagingKey, type BlobStore } from './blobstore';

/** S3 / MinIO store. Works with AWS S3 (default credential chain / instance role) or MinIO via S3_ENDPOINT. */
export class S3BlobStore implements BlobStore {
  private s3: S3Client;
  constructor(private bucket: string, opts: { endpoint?: string; region?: string } = {}) {
    this.s3 = new S3Client({ region: opts.region ?? 'us-east-1', endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint });
  }
  async presignPut(org: string, upload: string, sha256: string, size: number) {
    assertSafe(org, upload, false);
    const b64 = Buffer.from(sha256, 'hex').toString('base64');
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: stagingKey(org, upload), ChecksumSHA256: b64, ContentLength: size, ContentType: 'application/octet-stream' });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 600, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
    return { method: 'PUT' as const, url, headers: { 'x-amz-checksum-sha256': b64, 'content-type': 'application/octet-stream' }, expiresAt: new Date(Date.now() + 600_000) };
  }
  async statStaged(org: string, upload: string) {
    assertSafe(org, upload, false);
    try { const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: stagingKey(org, upload) })); return { size: Number(r.ContentLength) }; }
    catch (e) { if ((e as { name?: string }).name === 'NotFound') return null; throw e; }
  }
  async promote(org: string, upload: string, sha: string) {
    assertSafe(org, upload, false); assertSafe(org, sha, true);
    const key = blobKey(org, sha);
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${stagingKey(org, upload)}`, Key: key }));
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey(org, upload) }));
    return { key };
  }
  async put(org: string, data: Buffer) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    assertSafe(org, sha256, true);
    const key = blobKey(org, sha256);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
    return { sha256, size: data.length, key };
  }
  private async read(key: string) { const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return Buffer.from(await r.Body!.transformToByteArray()); }
  async get(org: string, sha: string) { assertSafe(org, sha, true); return this.read(blobKey(org, sha)); }
  async getStaged(org: string, upload: string) { assertSafe(org, upload, false); return this.read(stagingKey(org, upload)); }
  async presignGet(org: string, sha: string, filename: string) {
    assertSafe(org, sha, true);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(org, sha), ResponseContentDisposition: `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`, ResponseContentType: 'application/octet-stream' }), { expiresIn: 300 });
  }
  /** S3 DeleteObject succeeds for a missing key, so this is idempotent. */
  async delete(org: string, sha: string) {
    assertSafe(org, sha, true);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey(org, sha) }));
  }
  async deleteStaged(org: string, upload: string) {
    assertSafe(org, upload, false);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey(org, upload) }));
  }
}
