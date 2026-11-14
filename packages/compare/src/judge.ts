import type { PolicyRules } from '@lb/contracts';
import { compare, type CompareResult, type ObservationData } from './engine';

export interface RunLike { data: ObservationData; incomplete?: { reason: string } }

/**
 * The single place that turns "a replacement run happened (or didn't)" into a comparison result.
 * Shared by the verify worker and the exported replay, so both decide identically.
 *  - incomplete run (timeout, output cap, spawn failure): couldnt_run, or needs_reference when there is no reference
 *  - harness error (no observation at all): couldnt_run
 */
export function judge(policy: PolicyRules, reference: ObservationData | null, run: RunLike | null, harnessError?: string): CompareResult {
  if (run?.incomplete) {
    const base = compare(policy, reference, null);
    return reference ? { ...base, outcome: 'couldnt_run', diagnostics: { phase: 'run', reason: run.incomplete.reason } } : base;
  }
  const r = compare(policy, reference, run ? run.data : null);
  if (!run && r.outcome === 'couldnt_run') return { ...r, diagnostics: { phase: 'harness', reason: 'harness_error', message: (harnessError ?? '').slice(0, 500) } };
  return r;
}
