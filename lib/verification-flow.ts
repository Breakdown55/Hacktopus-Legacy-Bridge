import type { S1Project } from './s1-client';

type TestCase = { id: string; name: string; capture_id: string | null };
type Entry = { test_case_id: string; reference_output_id: string | null };
export type CaptureProgress = { couldnt_run?: { test_case_id: string; reason: string }[]; references?: number };
export function captureProblem(reason: string) {
  const reasons: Record<string, string> = {
    timeout: 'the original took too long', output_cap: 'the original produced too much output',
    harness_error: 'the original could not be started', resource_limit: 'the original exceeded its resource limits',
  };
  return reasons[reason] ?? 'the original could not finish this test';
}

/** Capture independent references first, then bind verification to the newly saved case set. */
export async function checkReplacement(options: {
  project: S1Project; cases: TestCase[]; original?: string; replacement?: string; runnable: boolean;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  wait: <T>(id: string, signal: AbortSignal) => Promise<T>;
  workspace: () => Promise<{ cases: TestCase[]; caseSet: Entry[] }>;
  signal: AbortSignal; progress: (message: string) => void;
}) {
  const { project, post, wait, signal, progress } = options;
  const path = '/projects/' + project.id;
  if (!options.replacement) throw new Error('The replacement runtime is not ready.');
  const missing = options.cases.filter(c => !c.capture_id);
  let capture: CaptureProgress | undefined;
  if (missing.length) {
    if (!options.original || !options.runnable) throw new Error('The original program is not ready to run. Check its execution status on Import before comparing tests.');
    progress('Running the original to record the expected results…');
    const job = await post<{ job_id: string }>(path + '/reference-captures', {
      source_revision_id: project.heads.current_source_revision_id, environment_id: options.original,
      test_case_ids: missing.map(c => c.id), repeat: 2,
    });
    capture = await wait<CaptureProgress>(job.job_id, signal);
  }
  signal.throwIfAborted();
  const latest = await options.workspace();
  const selected = new Set(options.cases.map(c => c.id));
  const cases = latest.cases.filter(c => selected.has(c.id));
  const absent = cases.filter(c => !c.capture_id);
  if (absent.length || cases.length !== selected.size) {
    const details = absent.slice(0, 3).map(c => {
      const failure = capture?.couldnt_run?.find(f => f.test_case_id === c.id);
      return c.name + ': ' + (failure ? captureProblem(failure.reason) : 'no original result was recorded');
    }).join('; ');
    throw new Error('Could not record all original results. ' + details + '. Comparison has not started.');
  }
  progress('Checking the replacement against the original results…');
  if (!project.heads.current_policy_id) await post(path + '/comparison-policies', {});
  const set = cases.map(c => ({ test_case_id: c.id, reference_output_id: c.capture_id }));
  const sameSet = set.length === latest.caseSet.length && set.every((entry, i) =>
    entry.test_case_id === latest.caseSet[i].test_case_id && entry.reference_output_id === latest.caseSet[i].reference_output_id);
  if (!sameSet || !project.heads.current_case_set_revision_id) await post(path + '/case-set-revisions', { set });
  const run = await post<{ job_id: string }>(path + '/verification-runs', { environment_id: options.replacement });
  await wait(run.job_id, signal);
}
