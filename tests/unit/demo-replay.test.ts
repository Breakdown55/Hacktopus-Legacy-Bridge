/** The "Bank Ledger" demo replay: recorded analysis and generation, replayed through the normal runner and validator. No Docker, no model. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRecording, ReplayGenerator, replayAnalysisRunner } from '../../workers/demo/bank-ledger';
import { validateGenerated } from '../../workers/generation/validate';
import { generateIncrementally } from '../../workers/generation/incremental';
import { generationTarget, TEMPLATE_VERSION, type GenerationRequest } from '../../workers/generation/provider';

const dir = join(__dirname, '../../fixtures/demo/bank-ledger');
const recording = loadRecording(dir)!;
const binary = join(dir, 'bankledger.stripped');

/** A scope like the one Select builds, with fresh behavior and finding ids for the recorded functions. */
function request(extra: Partial<GenerationRequest> = {}): GenerationRequest {
  const addresses = [...new Set(Object.values(recording.generation.behaviors))];
  const behaviors = addresses.map((address, i) => ({ id: 'feature-new' + i, statement: 'Keep the behavior of f' + i + '.', basis: 'inferred' as const, evidence: ['finding-' + i], notes: '' }));
  return {
    templateVersion: TEMPLATE_VERSION, target: generationTarget('typescript'),
    scope: { id: 's', sha256: 'x', document: { workflow: { name: 'Bank Ledger', invocation: { argv_template: [], stdin: 'text' } }, interface: { language: 'typescript', export: 'run' }, behaviors } as never },
    evidence: addresses.map((address, i) => ({ findingId: 'finding-' + i, kind: 'function', name: null, address, artifactSha256: recording.artifact_sha256, location: null, excerpt: '' })),
    ...extra,
  };
}
const generator = new ReplayGenerator(recording, { generationMs: 0, nameMs: 0 });
const signal = new AbortController().signal;

describe('Bank Ledger demo replay', () => {
  it('is recorded from the binary that ships next to it', () => {
    expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(recording.artifact_sha256);
  });

  it('replays the recorded analysis through the normal runner and normalizer', async () => {
    const result = await replayAnalysisRunner(recording, dir, 0).analyze({ targetPath: binary, artifactSha256: recording.artifact_sha256 });
    expect(result.outcome).toBe('complete');
    const pseudocode = new Set(result.findings.filter(f => f.kind === 'pseudocode').map(f => f.address));
    for (const address of Object.values(recording.generation.behaviors)) expect(pseudocode.has(address)).toBe(true);
  });

  it('returns the recorded name for a function and nothing for an unknown one', async () => {
    const [address, expected] = Object.entries(recording.names).find(([, v]) => v)!;
    const item = { findingId: 'f', kind: 'pseudocode', name: null, address, artifactSha256: '', location: null, excerpt: 'x' };
    expect(await generator.suggestFunctionName([item], signal)).toEqual(expected);
    expect(await generator.suggestFunctionName([{ ...item, address: '0xdead' }], signal)).toBeNull();
  });

  it('first asks its question, about a behavior of the current scope, in a module that passes validation', async () => {
    const req = request();
    const ids = new Set(req.scope.document.behaviors.map(b => b.id));
    const result = await generateIncrementally(generator, req, { signal }, async () => {});
    const untranslated = validateGenerated(result, ids, 'typescript');
    expect(untranslated).toHaveLength(1);
    expect(untranslated[0].question).toBeTruthy();
    expect(ids.has(untranslated[0].behaviorId!)).toBe(true);
    const markers = [...result.files.map(f => f.content).join('\n').matchAll(/LB-BEHAVIOR:([\w.-]+)/g)].map(m => m[1]);
    expect(markers.length).toBeGreaterThan(0);
    for (const id of markers) expect(ids.has(id)).toBe(true);
    expect(result.testCases?.length).toBeGreaterThan(0);
  });

  it('finishes once the question is answered, and not before', async () => {
    const req = request();
    const ids = new Set(req.scope.document.behaviors.map(b => b.id));
    const prior = { id: 'm1', files: [] };
    const still = await generator.generate({ ...req, priorRevision: prior, instructions: 'make it faster' }, { signal });
    expect(validateGenerated(still, ids, 'typescript')).toHaveLength(1);
    const done = await generator.generate({ ...req, priorRevision: prior, instructions: 'Question (q): how?\nAnswer: like this' }, { signal });
    expect(validateGenerated(done, ids, 'typescript')).toHaveLength(0);
    const implemented = new Set([...done.files.map(f => f.content).join('\n').matchAll(/LB-BEHAVIOR:([\w.-]+)/g)].map(m => m[1]));
    for (const id of ids) expect(implemented.has(id)).toBe(true);
  });

  it('drops markers for features that were not selected this time', async () => {
    const req = request();
    req.scope.document.behaviors.pop();
    const result = await generator.generate({ ...req, priorRevision: { id: 'm1', files: [] }, instructions: 'Answer: yes' }, { signal });
    const ids = new Set(req.scope.document.behaviors.map(b => b.id));
    for (const m of result.files.map(f => f.content).join('\n').matchAll(/LB-BEHAVIOR:([\w.-]+)/g)) expect(ids.has(m[1])).toBe(true);
  });
});
