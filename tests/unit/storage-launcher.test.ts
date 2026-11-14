import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FsBlobStore } from '../../server/storage/fs';
import { blobKey } from '../../server/storage/blobstore';
import { uuidv7 } from '../../server/db/ids';
import { hardeningArgs } from '../../workers/execution/runners';

describe('FsBlobStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'blobs-'));
  const s = new FsBlobStore(root), org = uuidv7();
  it('put/get is content-addressed and per-org', async () => {
    const { sha256 } = await s.put(org, Buffer.from('hi'));
    expect((await s.get(org, sha256)).toString()).toBe('hi');
    await expect(s.get(uuidv7(), sha256)).rejects.toThrow();
  });
  it('staging -> promote', async () => {
    const up = uuidv7();
    const { url } = await s.presignPut(org, up, 'a'.repeat(64), 3);
    const f = url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'abc');
    expect(await s.statStaged(org, up)).toEqual({ size: 3 });
    const sha = (await s.put(uuidv7(), Buffer.from('abc'))).sha256;
    const { key } = await s.promote(org, up, sha);
    expect(key).toBe(blobKey(org, sha));
    expect(await s.statStaged(org, up)).toBeNull();
  });
  it('rejects unsafe identifiers (no client-supplied keys)', async () => {
    await expect(s.get(org, '../../etc/passwd')).rejects.toThrow(/invalid/);
    await expect(s.statStaged('../x', uuidv7())).rejects.toThrow(/invalid/);
  });
});

describe('isolation flags (single source of truth)', () => {
  it('hardeningArgs applies every isolation control', () => {
    const a = hardeningArgs({ name: 'lb-x', runtime: 'runsc', platform: 'linux/amd64' });
    for (const f of ['--runtime=runsc', '--network=none', '--read-only', '--cap-drop=ALL', '--user=10001:10001', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m']) expect(a).toContain(f);
    expect(hardeningArgs({ name: 'lb-x' }).some((x) => x.startsWith('--runtime'))).toBe(false);
  });
});
