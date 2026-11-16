import { describe, expect, it } from 'vitest';
import { referencedConstants, supplementalEvidence } from '../../workers/generation/supplemental-evidence';
import type { Db } from '../../server/db/db';
import type { BlobStore } from '../../server/storage/blobstore';

function binary() {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32BE(0x7f454c46); bytes[4] = 2; bytes[5] = 1;
  bytes.writeBigUInt64LE(BigInt(64), 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(BigInt(128), 72);
  bytes.writeBigUInt64LE(BigInt(0x402000), 80); bytes.writeBigUInt64LE(BigInt(128), 96);
  bytes.write('OP\0DP\0WD\0XF\0ME\0', 128);
  return bytes;
}

describe('generation evidence investigation (static bytes only)', () => {
  it('recovers two-letter constants that a four-character string search misses', () => {
    const found = referencedConstants(binary(), 'memcmp(input,DAT_00402000,2); DAT_00402003; DAT_00402000');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ address: '0x00402000', fileOffset: 128, textBeforeNull: 'OP' });
    expect(found[1].textBeforeNull).toBe('DP');
  });
  it('does not resolve unmapped addresses or malformed binaries', () => {
    expect(referencedConstants(binary(), 'DAT_00403000')).toEqual([]);
    expect(referencedConstants(Buffer.from('not an ELF'), 'DAT_00402000')).toEqual([]);
    const truncated = binary(); truncated.writeBigUInt64LE(BigInt(999999), 32);
    expect(referencedConstants(truncated, 'DAT_00402000')).toEqual([]);
  });
  it('collects only bounded supporting text from the requested source and organization', async () => {
    const calls: unknown[][] = [];
    const db = { query: async (_sql: string, args: unknown[]) => {
      calls.push(args);
      return [
        { path: 'input.txt', role: 'data_file', blob_sha256: 'a', size_bytes: 3 },
        { path: 'big.txt', role: 'data_file', blob_sha256: 'b', size_bytes: 33000 },
        { path: 'source.c', role: 'other', blob_sha256: 'c', size_bytes: 3 },
      ];
    } } as unknown as Db;
    const store = { get: async (org: string, hash: string) => {
      expect([org, hash]).toEqual(['org', 'a']); return Buffer.from('OP\n');
    } } as BlobStore;
    const evidence = await supplementalEvidence(db, store, 'org', 'source', []);
    expect(calls).toEqual([['org', 'source']]);
    expect(evidence).toMatchObject([{ kind: 'supporting_file', name: 'input.txt', artifactSha256: 'a', excerpt: 'OP\n' }]);
  });
});
