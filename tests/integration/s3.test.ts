/**
 * S3BlobStore against a real S3-compatible server. Skipped unless S3_TEST_ENDPOINT is set, e.g.:
 *   docker run -d -p 9090:9090 adobe/s3mock && curl -X PUT localhost:9090/legacy-bridge
 *   S3_TEST_ENDPOINT=http://localhost:9090 npx vitest run tests/integration
 * Verified against Adobe S3Mock only: not yet against MinIO or AWS S3 (plan spike F4 stays open for those).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3BlobStore } from '../../server/storage/s3';

const endpoint = process.env.S3_TEST_ENDPOINT;
if (!endpoint) console.warn('[s3] SKIPPED: set S3_TEST_ENDPOINT');

describe.skipIf(!endpoint)('S3BlobStore', () => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test'; process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const s = new S3BlobStore(process.env.S3_TEST_BUCKET ?? 'legacy-bridge', { endpoint });
  const org = '11111111-1111-1111-1111-111111111111', up = '22222222-2222-2222-2222-222222222222';
  const data = Buffer.from('hello legacy bridge');
  const sha = createHash('sha256').update(data).digest('hex');

  it('enforces the declared checksum, promotes, and serves attachments', async () => {
    const p = await s.presignPut(org, up, sha, data.length);
    const put = (body: Buffer) => fetch(p.url, { method: 'PUT', headers: p.headers, body: new Uint8Array(body) });
    expect((await put(Buffer.from('tampered contents!'))).status).toBe(400); // same length, different bytes
    expect((await put(data)).status).toBe(200);
    expect(await s.statStaged(org, up)).toEqual({ size: data.length });
    await s.promote(org, up, sha);
    expect((await s.get(org, sha)).equals(data)).toBe(true);
    expect(await s.statStaged(org, up)).toBeNull();
    const r = await fetch(await s.presignGet(org, sha, 'a b.bin'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="a_b.bin"');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });
});
