/** AnthropicGenerator against an injected FAKE SDK client. No network; the live API has never been called. */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicGenerator } from '../../workers/generation/anthropic';
import { RUN_CONTRACT, type GenerationRequest } from '../../workers/generation/provider';

const req: GenerationRequest = {
  templateVersion: 'ts-cli-v1', scope: { id: 's', sha256: 'x', document: {} as never }, evidence: [],
  target: { language: 'typescript', runtime: 'node22', entry: 'src/index.ts', export: 'run', allowRuntimeDeps: false, runContract: RUN_CONTRACT },
};
const signal = new AbortController().signal;
const ok = (over: Record<string, unknown> = {}) => ({
  model: 'claude-x-1', stop_reason: 'tool_use', stop_details: null, usage: { input_tokens: 5, output_tokens: 7 },
  content: [{ type: 'tool_use', id: 't', name: 'submit_module', input: { files: [{ path: 'src/index.ts', content: 'x' }], untranslated: [], notes: 'n' } }], ...over,
});
function fake(outcome: () => unknown) {
  const sent: any[] = [];
  const client = { beta: { messages: { create: async (b: unknown) => { sent.push(b); return outcome(); } } } } as unknown as Anthropic;
  return { sent, gen: new AnthropicGenerator({ client }) };
}
const apiError = (status: number) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'secret prompt text' } }, 'secret prompt text', new Headers());

describe('AnthropicGenerator', () => {
  it('builds a request without forced tool use, with a strict tool, effort high and the run contract', async () => {
    const { sent, gen } = fake(() => ok());
    const r = await gen.generate(req, { signal });
    const b = sent[0];
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toEqual({ effort: 'high' });
    expect(b.tools[0]).toMatchObject({ name: 'submit_module', strict: true, input_schema: { additionalProperties: false, required: ['files', 'untranslated', 'notes'] } });
    expect(b.tools[0].input_schema.properties.files.items).toMatchObject({ additionalProperties: false, required: ['path', 'content'] });
    expect(b.system).toContain(RUN_CONTRACT);
    expect(b.messages[0].content).toContain('runContract');
    expect(b.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(b.fallbacks).toBe('default');
    expect(r).toMatchObject({ files: [{ path: 'src/index.ts' }], usage: { inputTokens: 5, outputTokens: 7 }, modelVersion: 'claude-x-1', notes: 'n' });
  });
  it('maps rate limits and connection errors to retryable, 5xx to a retried HTTP error, other 4xx to a provider error', async () => {
    await expect(fake(() => { throw apiError(429); }).gen.generate(req, { signal })).rejects.toThrow(/rate limited/);
    await expect(fake(() => { throw new Anthropic.APIConnectionError({ message: 'down' }); }).gen.generate(req, { signal })).rejects.toThrow(/connection failed/);
    await expect(fake(() => { throw apiError(503); }).gen.generate(req, { signal })).rejects.toThrow(/HTTP 503/);
    const e = await fake(() => { throw apiError(400); }).gen.generate(req, { signal }).catch((x) => x);
    expect(e).toMatchObject({ code: 'generation_provider_error' });
    expect(String(e.message)).not.toContain('secret');
  });
  it('treats max_tokens and a missing tool call as invalid output, and a refusal as generation_refused', async () => {
    await expect(fake(() => ok({ stop_reason: 'max_tokens' })).gen.generate(req, { signal })).rejects.toMatchObject({ code: 'generation_output_invalid' });
    await expect(fake(() => ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'here is code' }] })).gen.generate(req, { signal })).rejects.toMatchObject({ code: 'generation_output_invalid' });
    await expect(fake(() => ok({ content: [{ type: 'tool_use', id: 't', name: 'other', input: {} }] })).gen.generate(req, { signal })).rejects.toMatchObject({ code: 'generation_output_invalid' });
    const r = await fake(() => ok({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] })).gen.generate(req, { signal }).catch((x) => x);
    expect(r).toMatchObject({ code: 'generation_refused' });
    expect(String(r.message)).toContain('cyber');
  });
});
