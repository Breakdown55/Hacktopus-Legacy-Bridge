import { describe, expect, it, vi } from 'vitest';
import { checkReplacement } from '../../lib/verification-flow';
import type { S1Project } from '../../lib/s1-client';

function setup(captured = false) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const cases = [{ id: 'case', name: 'Sample input', capture_id: captured ? 'reference' : null }];
  const options = {
    project: { id: 'project', heads: { current_source_revision_id: 'source', current_policy_id: 'policy', current_case_set_revision_id: 'old-set' } } as S1Project,
    cases, original: 'original', replacement: 'replacement', runnable: true,
    post: async <T>(path: string, body?: unknown): Promise<T> => { calls.push(path); bodies.push(body); return { job_id: path.includes('reference-captures') ? 'capture' : 'verify', body } as T; },
    wait: async <T>(job: string): Promise<T> => { calls.push('wait:' + job); if (job === 'capture') cases[0].capture_id = 'reference'; return {} as T; },
    workspace: async () => ({ cases, caseSet: [] }),
    signal: new AbortController().signal, progress: vi.fn(),
  };
  return { calls, options, bodies };
}

describe('Check replacement', () => {
  it('captures missing original results before binding and running verification', async () => {
    const { calls, options, bodies } = setup();
    await checkReplacement(options);
    expect(calls).toEqual(['/projects/project/reference-captures', 'wait:capture', '/projects/project/case-set-revisions', '/projects/project/verification-runs', 'wait:verify']);
    expect(bodies[1]).toEqual({ set: [{ test_case_id: 'case', reference_output_id: 'reference' }] });
  });
  it('reuses existing independent references', async () => {
    const { calls, options } = setup(true);
    await checkReplacement(options);
    expect(calls.some(p => p.includes('reference-captures'))).toBe(false);
  });
  it('explains capture failures and never starts a reference-less comparison', async () => {
    const { calls, options } = setup();
    options.wait = async <T>() => ({ couldnt_run: [{ test_case_id: 'case', reason: 'timeout' }] }) as T;
    await expect(checkReplacement(options)).rejects.toThrow('Sample input: the original took too long');
    expect(calls).toEqual(['/projects/project/reference-captures']);
  });
  it('does not try to execute an unavailable original', async () => {
    const { calls, options } = setup();
    options.runnable = false;
    await expect(checkReplacement(options)).rejects.toThrow('not ready to run');
    expect(calls).toEqual([]);
  });
});
