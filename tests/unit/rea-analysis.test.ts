import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReaAnalysisResult, normalizeReaEvidence } from '../../workers/analysis/rea/normalize';
import { DockerReaAnalysisRunner } from '../../workers/analysis/rea/runner';
import { buildElf } from '../helpers/elf';
import { addAddress, fixtureArtifactSha, recording, replayImageDigest, replayRea } from '../helpers/rea-replay';

let directory: string, targetPath: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'lb-rea-replay-'));
  targetPath = join(directory, 'artifact');
  // The fake executor supplies the recorded result; the runner still checks the target header.
  writeFileSync(targetPath, buildElf());
});
afterAll(() => {
  unlinkSync(targetPath);
  rmdirSync(directory);
});
// Text symbol addresses from the unstripped binary built alongside this exact recording.
const symbolOracle = ['0x4011a0', '0x401120', '0x401624', '0x401000', '0x4010f0', '0x401286',
  '0x4011d6', '0x401130', '0x4011d0', '0x401399', '0x401160', '0x401231'];

describe('REA analysis adapter', () => {
  it('matches the recording to its artifact, operation, and requested address', () => {
    const raw = recording('decompile');
    expect(normalizeReaEvidence(raw, 'decompile', fixtureArtifactSha, addAddress).raw).toEqual(raw);
    expect(() => normalizeReaEvidence(raw, 'decompile', fixtureArtifactSha, '0x401231')).toThrow('invalid_provider_evidence');
    expect(() => normalizeReaEvidence(raw, 'decompile', '0'.repeat(64), addAddress)).toThrow('invalid_provider_evidence');
    expect(() => normalizeReaEvidence(raw, 'xrefs', fixtureArtifactSha, addAddress)).toThrow('invalid_provider_evidence');
  });

  it('finds text addresses in the stripped recording and keeps procedures, imports, and strings traceable', async () => {
    const replay = replayRea();
    const execute = vi.fn(replay.execute);
    const runner = new DockerReaAnalysisRunner({ image: 'lb-analysis:test', runtime: 'runsc', execute });
    const result = await runner.analyze({ targetPath, artifactSha256: fixtureArtifactSha });
    expect(result, JSON.stringify(result.coverage)).toMatchObject({ outcome: 'complete', artifactSha256: fixtureArtifactSha,
      versions: { rea: '6.9.0', ghidra: '12.1', image: replayImageDigest } });
    const functions = new Set(result.findings.filter((f) => f.kind === 'function').map((f) => f.address));
    expect(symbolOracle.filter((address) => !functions.has(address))).toEqual([]);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import', name: expect.stringContaining('qsort'), authority: 'observed_static' }),
      expect.objectContaining({ kind: 'string', name: 'stopwords.txt', authority: 'observed_static' }),
      expect.objectContaining({ kind: 'string', name: 'GCC: (GNU) 13.5.0', location: { address: '.comment:0x0' } }),
      expect.objectContaining({ kind: 'function', address: addAddress, authority: 'tool_inferred' }),
    ]));
    for (const finding of result.findings) {
      const source = result.evidence.find(({ raw }) => JSON.parse(raw.toString('utf8')).evidence_id === finding.providerEvidenceId);
      expect(source?.raw).toEqual(replay.captures.get(finding.providerEvidenceId));
      expect(source).toBeDefined();
    }
    const launches = execute.mock.calls.map(([, args]) => args).filter(([command]) => command === 'run');
    expect(launches).toHaveLength(3);
    for (const args of launches) {
      expect(args).toEqual(expect.arrayContaining([
        '--pull=never', '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--runtime=runsc', replayImageDigest,
      ]));
      const mounts = args.flatMap((arg, i) => arg === '--mount' ? [args[i + 1]] : []);
      expect(mounts).toEqual([`type=bind,src=${targetPath},dst=/input/artifact,readonly`]);
    }
  });

  it('retains procedure findings and a precise limitation when the strings operation times out', async () => {
    const replay = replayRea(fixtureArtifactSha, 'strings');
    const runner = new DockerReaAnalysisRunner({ image: replayImageDigest, execute: replay.execute });
    const result = await runner.analyze({ targetPath, artifactSha256: fixtureArtifactSha });
    expect(result.outcome).toBe('partial');
    expect(result.limitations).toContain('strings:timeout');
    expect(result.evidence.some((entry) => entry.kind === 'strings')).toBe(false);
    expect(result.findings.some((finding) => finding.kind === 'function' && finding.address === addAddress)).toBe(true);
  });

  it('preserves valid raw bytes while sanitizing storage fields and rejecting invalid UTF-8', () => {
    const document = JSON.parse(recording('strings').toString('utf8'));
    document.normalized_result = [{ address: '0x402000', value: 'a\0b', string: { encoding: 'UTF\ud8008' } }];
    const raw = Buffer.from(JSON.stringify(document));
    const evidence = normalizeReaEvidence(raw, 'strings', fixtureArtifactSha);
    const result = buildReaAnalysisResult({ artifactSha256: fixtureArtifactSha, scope: 'inventory',
      versions: { rea: '6.9.0', ghidra: '12.1', image: replayImageDigest },
      operations: [{ kind: 'strings', status: 'complete', evidence }],
    });
    expect(result.evidence[0].raw).toEqual(raw);
    expect(result.findings[0]).toMatchObject({ name: 'a\uFFFDb', attributes: { encoding: 'UTF\uFFFD8' } });
    const corrupt = Buffer.from(raw);
    corrupt[corrupt.indexOf('subject')] = 0xff;
    expect(() => normalizeReaEvidence(corrupt, 'strings', fixtureArtifactSha)).toThrow();
  });

  it('reports bounded inventory coverage while retaining the full successful response', () => {
    const document = JSON.parse(recording('strings').toString('utf8'));
    document.normalized_result = Array.from({ length: 8193 }, (_, i) => ({ address: `0x${(0x402000 + i).toString(16)}`, value: `String ${i}` }));
    const raw = Buffer.from(JSON.stringify(document));
    const evidence = normalizeReaEvidence(raw, 'strings', fixtureArtifactSha);
    const result = buildReaAnalysisResult({ artifactSha256: fixtureArtifactSha, scope: 'inventory',
      versions: { rea: '6.9.0', ghidra: '12.1', image: replayImageDigest },
      operations: [{ kind: 'strings', status: 'complete', evidence }],
    });
    expect(result.findings).toHaveLength(8192);
    expect(result.evidence[0].raw).toEqual(raw);
    expect(result).toMatchObject({ outcome: 'partial', coverage: { operations: [
      { kind: 'strings', status: 'partial', rows: 8193, indexedRows: 8192 },
    ] } });
  });
});
