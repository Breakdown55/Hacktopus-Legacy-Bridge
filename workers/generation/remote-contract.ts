import { z } from 'zod';
import type { GenerationRequest } from './provider';
import { codexModuleSchema } from './codex';

export const remoteGenerationKind = 'codex.generate';
export const remoteGenerationPath = '/api/codex/generation';
export const remoteGenerationLimit = 5 * 1024 * 1024;

export const remoteResultSchema = codexModuleSchema.extend({
  usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
});
export const remoteFailureSchema = z.enum(['generation_provider_error', 'generation_output_invalid', 'generation_refused', 'transient']);

export type RemoteGenerationJob = { id: string; lease: string; model?: string; request: GenerationRequest };
