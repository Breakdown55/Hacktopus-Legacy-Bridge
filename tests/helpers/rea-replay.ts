import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReaOperation = 'procedures' | 'strings' | 'xrefs' | 'decompile' | 'decompile_all';
const recordings = join(__dirname, '../fixtures/rea-wordfreq');

export const fixtureArtifactSha = '042f2cdbcb09dacc4ef9e14ed5c8365c84c0b4dd8c0f2b3da559285bc538ec11';
export const replayImageDigest = `sha256:${'3'.repeat(64)}`;
export const addAddress = '0x401286';

export function recording(operation: ReaOperation): Buffer {
  return readFileSync(join(recordings, `${operation}.json`));
}

export function defaultSpaceAddress(address: string): string {
  const match = /^(?:ram:)?(?:0x)?([0-9a-f]+)$/i.exec(address);
  if (!match) throw new Error(`Expected a default-space address: ${address}`);
  return `0x${BigInt(`0x${match[1]}`).toString(16)}`;
}

export function replayRea(artifactSha256 = fixtureArtifactSha, timeoutAt?: ReaOperation) {
  const captures = new Map<string, Buffer>();
  const operations: ReaOperation[] = [];
  const execute = async (_bin: string, args: string[]): Promise<Buffer> => {
    if (args[0] === 'image') return Buffer.from(`${replayImageDigest}\n`);
    if (args[0] === 'rm') return Buffer.alloc(0);
    const operation = args.includes('decompile-all') ? 'decompile_all' as const
      : (['procedures', 'strings', 'xrefs', 'decompile'] as const).find((name) => args.includes(name));
    if (!operation) throw new Error(`Unexpected replay arguments: ${args.join(' ')}`);
    operations.push(operation);
    if (timeoutAt === operation) throw Object.assign(new Error('simulated provider timeout'), { code: 'ETIMEDOUT' });
    if (operation === 'decompile_all') {
      // Recorded from fixtures/bin/wordfreq.stripped (-O1), a different build from the other recordings: only 0x4011d6 is common to both.
      // The runner returns { envelope, functions }; the envelope alone is the raw evidence record.
      const packed = JSON.parse(recording(operation).toString('utf8'));
      const record = JSON.parse(packed.envelope);
      record.subject.digest.sha256 = artifactSha256;
      record.normalized_result.target_sha256 = artifactSha256;
      packed.envelope = JSON.stringify(record);
      captures.set(record.evidence_id, Buffer.from(packed.envelope));
      return Buffer.from(JSON.stringify(packed));
    }
    const original = recording(operation);
    const envelope = JSON.parse(original.toString('utf8'));
    const address = args.find((arg) => /^(?:ram:)?0x[0-9a-f]+$/i.test(arg));
    const differentAddress = operation === 'xrefs' && address && defaultSpaceAddress(address) !== addAddress;
    if (differentAddress) {
      // The F1 recording covers only the add function. Other replayed xref queries yield no observations.
      envelope.parameters.address = address;
      envelope.normalized_result = [];
      envelope.evidence_id = `ev_${address.replace(/^(?:ram:)?0x/i, '').padStart(64, '0')}`;
    }
    envelope.subject.digest.sha256 = artifactSha256;
    const bytes = artifactSha256 === fixtureArtifactSha && !differentAddress ? original : Buffer.from(JSON.stringify(envelope));
    captures.set(envelope.evidence_id, bytes);
    return bytes;
  };
  return { execute, captures, operations };
}
