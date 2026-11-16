import type { CodeGenerator, GenerationRequest, GenerationResult } from './provider';
import { validateGenerated } from './validate';

export type FeatureProgress = { id: string; state: 'queued' | 'generating' | 'generated' | 'unresolved' };
export function featureStates(request: GenerationRequest, result: GenerationResult): FeatureProgress[] {
  const source = result.files.map(f => f.content).join('\n');
  const implemented = new Set([...source.matchAll(/LB-BEHAVIOR:([\w.-]+)/g)].map(m => m[1]));
  return request.scope.document.behaviors.map(b => ({ id: b.id, state:
    implemented.has(b.id) && !result.untranslated.some(u => u.behaviorId === b.id) ? 'generated' : 'unresolved' }));
}

/** Each call returns a validated cumulative package; only the final package is published. */
export async function generateIncrementally(generator: CodeGenerator, request: GenerationRequest, context: Parameters<CodeGenerator['generate']>[1],
  progress: (features: FeatureProgress[]) => Promise<void>): Promise<GenerationResult> {
  let features: FeatureProgress[] = request.scope.document.behaviors.map(b => ({ id: b.id, state: 'queued' }));
  let result: GenerationResult | undefined;
  const transcripts: unknown[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const behavior of request.scope.document.behaviors) {
    context.signal.throwIfAborted();
    features = features.map(f => f.id === behavior.id ? { ...f, state: 'generating' } : f);
    await progress(features);
    const step = { ...request, activeBehaviorId: behavior.id, priorRevision: result
      ? { id: request.priorRevision?.id ?? request.scope.id, files: result.files } : request.priorRevision };
    const next = await generator.generate(step, context);
    validateGenerated(next, new Set(request.scope.document.behaviors.map(b => b.id)), request.target.language);
    result = next;
    transcripts.push(next.transcript);
    usage.inputTokens += next.usage.inputTokens; usage.outputTokens += next.usage.outputTokens;
    const states = featureStates(request, next);
    const activeIndex = features.findIndex(f => f.id === behavior.id);
    features = features.map((f, index) => index <= activeIndex ? states[index] : f);
    await progress(features);
  }
  if (!result) return generator.generate(request, context);
  return { ...result, usage, transcript: { steps: transcripts } };
}
