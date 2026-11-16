import type { Db } from '../../server/db/db';
import type { BlobStore } from '../../server/storage/blobstore';
import type { EvidenceItem } from './provider';

/** Resolve decompiler DAT addresses to file-backed ELF64 bytes, without executing the artifact. */
export function referencedConstants(binary: Buffer, text: string) {
  if (binary.length < 64 || binary.readUInt32BE(0) !== 0x7f454c46 || binary[4] !== 2 || binary[5] !== 1) return [];
  const offset = Number(binary.readBigUInt64LE(32)), size = binary.readUInt16LE(54), count = binary.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size < 56) return [];
  const addresses = [...new Set([...text.matchAll(/\bDAT_([0-9a-fA-F]{6,16})\b/g)].map(m => m[1]))].slice(0, 64);
  return addresses.flatMap(address => {
    const value = BigInt('0x' + address);
    for (let i = 0; i < count; i++) {
      const p = offset + i * size;
      if (p < 0 || p + 56 > binary.length) break;
      if (binary.readUInt32LE(p) !== 1) continue;
      const base = binary.readBigUInt64LE(p + 16), length = binary.readBigUInt64LE(p + 32);
      if (value < base || value >= base + length) continue;
      const fileOffset = binary.readBigUInt64LE(p + 8) + value - base;
      if (fileOffset >= BigInt(binary.length)) return [];
      const start = Number(fileOffset), end = Math.min(start + 32, binary.length, start + Number(base + length - value));
      const bytes = binary.subarray(start, end);
      const zero = bytes.indexOf(0);
      return [{ address: '0x' + address, fileOffset: start, hex: bytes.toString('hex'), textBeforeNull: bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('latin1') }];
    }
    return [];
  });
}

/** Additional context is provenance-tagged and bounded; it never becomes a reference output. */
export async function supplementalEvidence(db: Db, store: BlobStore, orgId: string, sourceId: string, evidence: EvidenceItem[]) {
  const artifacts = await db.query<{ path: string; role: string; blob_sha256: string; size_bytes: number }>(
    'SELECT path,role,blob_sha256,size_bytes FROM source_artifacts WHERE org_id=$1 AND source_revision_id=$2 ORDER BY path', [orgId, sourceId]);
  const out: EvidenceItem[] = [];
  let remaining = Math.max(0, Math.min(32 * 1024, 200 * 1024 - evidence.reduce((n, item) => n + item.excerpt.length, 0)));
  const add = (artifact: typeof artifacts[number], kind: string, excerpt: string) => {
    const bounded = excerpt.slice(0, Math.min(8192, remaining));
    if (!bounded) return;
    remaining -= bounded.length;
    out.push({ findingId: 'artifact:' + artifact.blob_sha256, kind, name: artifact.path, address: null,
      artifactSha256: artifact.blob_sha256, location: { path: artifact.path }, excerpt: bounded });
  };
  const primary = artifacts.find(a => a.role === 'primary_executable');
  if (primary && evidence.some(item => /\bDAT_[0-9a-fA-F]{6,16}\b/.test(item.excerpt)) && Number(primary.size_bytes) <= 200 * 1024 * 1024) {
    const bytes = await store.get(orgId, primary.blob_sha256);
    const constants = referencedConstants(bytes, evidence.map(e => e.excerpt).join('\n'));
    if (constants.length) add(primary, 'binary_constants', JSON.stringify(constants));
  }
  for (const artifact of artifacts) {
    if (remaining <= 0) break;
    if (!['data_file', 'documentation'].includes(artifact.role) || !/\.(txt|csv|tsv|json|md|log|dat)$/i.test(artifact.path) || Number(artifact.size_bytes) > 32 * 1024) continue;
    const bytes = await store.get(orgId, artifact.blob_sha256);
    if (bytes.includes(0)) continue;
    add(artifact, 'supporting_file', bytes.toString('utf8'));
  }
  return out;
}
