import { describe, expect, it } from 'vitest';
import { ScopeDocV1 } from '@lb/contracts';
import { generateIncrementally, type FeatureProgress } from '../../workers/generation/incremental';
import { generationTarget, type CodeGenerator, type GenerationRequest, type GenerationResult } from '../../workers/generation/provider';

const request: GenerationRequest = {
  templateVersion: 'ts-cli-v1', scope: { id: 'scope', sha256: 'sha', document: ScopeDocV1.parse({
    workflow: { name: 'Ledger', invocation: { argv_template: [] } }, interface: { language: 'typescript' },
    behaviors: [{ id: 'open', statement: 'Open accounts', basis: 'inferred', evidence: [] }, { id: 'deposit', statement: 'Deposit money', basis: 'inferred', evidence: [] }],
  }) }, evidence: [], target: generationTarget('typescript'),
};
const result = (source: string): GenerationResult => ({ files: [{ path: 'src/index.ts', content: source }], untranslated: [], notes: '', usage: { inputTokens: 1, outputTokens: 2 }, transcript: { source } });

describe('sequential feature generation', () => {
  it('generates each feature with the cumulative code and reports real progress in order', async () => {
    const requests: GenerationRequest[] = [];
    const events: FeatureProgress[][] = [];
    const generator: CodeGenerator = { describe: () => ({ provider: 'fake', model: 'fake' }), generate: async step => {
      requests.push(step);
      return result((step.priorRevision?.files[0].content ?? 'export function run() {}\n') + `/* LB-BEHAVIOR:${step.activeBehaviorId} */`);
    } };
    const output = await generateIncrementally(generator, request, { signal: new AbortController().signal }, async states => { events.push(structuredClone(states)); });
    expect(requests.map(r => r.activeBehaviorId)).toEqual(['open', 'deposit']);
    expect(requests[1].priorRevision?.files[0].content).toContain('LB-BEHAVIOR:open');
    expect(events.map(e => e.map(f => f.state))).toEqual([
      ['generating', 'queued'], ['generated', 'queued'], ['generated', 'generating'], ['generated', 'generated'],
    ]);
    expect(output.usage).toEqual({ inputTokens: 2, outputTokens: 4 });
    expect(output.transcript).toHaveProperty('steps');
  });
  it('keeps an unresolved feature yellow while proceeding to the next feature', async () => {
    const events: FeatureProgress[][] = [];
    const gap = { id: 'missing-code', behaviorId: 'open', file: 'src/index.ts', line: 1, reason: 'Missing input format', evidence: [] };
    const generator: CodeGenerator = { describe: () => ({ provider: 'fake', model: 'fake' }), generate: async step => ({
      ...result('export function run() {}' + (step.activeBehaviorId === 'deposit' ? '/* LB-BEHAVIOR:deposit */' : '')), untranslated: [gap],
    }) };
    await generateIncrementally(generator, request, { signal: new AbortController().signal }, async states => { events.push(structuredClone(states)); });
    expect(events.at(-1)?.map(f => f.state)).toEqual(['unresolved', 'generated']);
  });
  it('rejects invalid intermediate code before generating further features', async () => {
    let calls = 0;
    const generator: CodeGenerator = { describe: () => ({ provider: 'fake', model: 'fake' }), generate: async () => {
      calls++; return { ...result('x'), files: [{ path: '../unsafe.ts', content: 'x' }] };
    } };
    await expect(generateIncrementally(generator, request, { signal: new AbortController().signal }, async () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
