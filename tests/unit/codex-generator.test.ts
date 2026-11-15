import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { CodexGenerator } from '../../workers/generation/codex';
import { RUN_CONTRACT, type GenerationRequest } from '../../workers/generation/provider';
import { RetryableError } from '../../workers/runtime';

const request: GenerationRequest = {
  templateVersion: 'ts-cli-v1', scope: { id: 'scope', sha256: 'digest', document: {} as never },
  evidence: [{ findingId: 'f', kind: 'pseudocode', name: null, address: '0x10', artifactSha256: 'sha', location: {}, excerpt: 'Untrusted input' }],
  target: { language: 'typescript', runtime: 'node22', entry: 'src/index.ts', export: 'run', allowRuntimeDeps: false, runContract: RUN_CONTRACT },
};
const options = () => ({ signal: new AbortController().signal });
const success = {
  code: null, stderr: '',
  stdout: '{"type":"item.completed","item":{"text":"internal event"}}\n{"type":"turn.completed","usage":{"input_tokens":14,"output_tokens":22}}\n',
};
const moduleOutput = { files: [{ path: 'src/index.ts', content: 'example' }], untranslated: [], notes: '' };

describe('CodexGenerator', () => {
  it('sends a scope and evidence via stdin and keeps credentials, raw events, and tool permissions out', async () => {
    vi.stubEnv('DATABASE_URL', 'sensitive-database');
    vi.stubEnv('OPENAI_API_KEY', 'sensitive-key');
    vi.stubEnv('LB_CODEX_WORKER_KEY', 'sensitive-worker');
    let directory = '';
    try {
      const generator = new CodexGenerator({ binary: 'fixture-codex', model: 'fixture-model', execute: async (binary, args, call) => {
        expect(binary).toBe('fixture-codex');
        expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'shell_tool', 'hooks', 'multi_agent', 'plugins', 'fixture-model', 'approval_policy="never"', '-']));
        expect(args.join(' ')).not.toContain('Untrusted input');
        expect(call.input).toContain('Untrusted input');
        expect(call.input).toContain(RUN_CONTRACT);
        expect(call.env).not.toHaveProperty('DATABASE_URL');
        expect(call.env).not.toHaveProperty('OPENAI_API_KEY');
        expect(call.env).not.toHaveProperty('LB_CODEX_WORKER_KEY');
        const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
        expect(schema).toMatchObject({ additionalProperties: false, required: ['files', 'untranslated', 'notes'] });
        directory = call.cwd;
        await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(moduleOutput));
        return success;
      } });
      const result = await generator.generate(request, options());
      expect(result).toMatchObject({ ...moduleOutput, usage: { inputTokens: 14, outputTokens: 22 }, transcript: { request, response: moduleOutput, provider: 'codex', model: 'fixture-model' } });
      expect(JSON.stringify(result.transcript)).not.toContain('internal event');
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['not JSON', '{"files":[],"untranslated":[]}', '{"files":[],"untranslated":[],"notes":"ok","extra":1}', null])(
    'fails safely on missing or malformed output (%s)', async (payload) => {
      const generator = new CodexGenerator({ execute: async (_, args) => {
        if (payload !== null) await writeFile(args[args.indexOf('--output-last-message') + 1], payload);
        return success;
      } });
      await expect(generator.generate(request, options())).rejects.toMatchObject({ code: 'generation_output_invalid' });
    },
  );

  it('classifies throttling, missing CLI, and refusals without exposing the provider message', async () => {
    const client = (stderr: string, code: string | number, stdout = '') =>
      new CodexGenerator({ execute: async () => ({ stdout, stderr, code }) });
    await expect(client('', 1, '{"type":"turn.failed","error":{"message":"HTTP 503: [private]"}}').generate(request, options()))
      .rejects.toBeInstanceOf(RetryableError);
    await expect(client('[private]', 'ENOENT').generate(request, options())).rejects.toMatchObject({ code: 'generation_provider_error', message: 'generation_provider_error' });
    await expect(client('refusal [private]', 1).generate(request, options())).rejects.toMatchObject({ code: 'generation_refused', message: 'generation_refused' });
  });

  it('discards any output after cancellation', async () => {
    const abort = new AbortController();
    const generator = new CodexGenerator({ execute: async () => {
      abort.abort();
      return success;
    } });
    await expect(generator.generate(request, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
