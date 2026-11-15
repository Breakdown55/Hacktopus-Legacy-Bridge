import { createHash } from 'node:crypto';
import type { Observation, PolicyRules } from '@lb/contracts';
import { applyNormalizer, hasNormalizer, normalizerKey } from './normalizers';

export const COMPARE_ENGINE_VERSION = '1.1.0';

/** An observation plus the bytes behind its digests. The engine does no I/O. */
export interface ObservationData {
  observation: Observation;
  stdout: Buffer;
  stderr: Buffer;
  files: Record<string, Buffer>;
  /** Set on references only: false when repeat captures disagreed. */
  deterministic?: boolean | null;
  /** Channels that varied between captures (when deterministic === false). */
  varied_channels?: string[];
}

export type Outcome = 'match' | 'difference' | 'couldnt_run' | 'needs_reference';

export interface TraceEntry {
  channel: string;
  normalizer: string;
  changed_bytes_expected: number;
  changed_bytes_actual: number;
  /** Tolerance entries record the thresholds that were applied. */
  params?: Record<string, number | string>;
}

export interface CompareResult {
  outcome: Outcome;
  raw_equal: boolean | null;
  normalized: boolean;
  normalization_trace: TraceEntry[];
  differences: Record<string, unknown>[];
  diagnostics: Record<string, unknown> | null;
  not_compared: string[];
  digests: Record<string, { expected: string | null; actual: string | null }>;
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const empty = (): Omit<CompareResult, 'outcome'> => ({
  raw_equal: null,
  normalized: false,
  normalization_trace: [],
  differences: [],
  diagnostics: null,
  not_compared: [],
  digests: {},
});

/** Converts a glob (`*`, `**`, `?`) into a RegExp over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function firstDifference(a: Buffer, b: Buffer) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  let line = 1;
  let col = 1;
  for (let k = 0; k < i; k++) {
    if (a[k] === 0x0a) {
      line++;
      col = 1;
    } else col++;
  }
  return { byte: i, line, column: col };
}

const excerpt = (b: Buffer, at: number) => b.subarray(Math.max(0, at - 8), at + 24).toString('utf8');

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** decimal-v1: split into numeric and non-numeric tokens; non-numeric must match exactly, numeric within abs/rel. */
export function toleranceEqual(a: Buffer, b: Buffer, abs: number, rel: number): boolean {
  const sa = a.toString('latin1');
  const sb = b.toString('latin1');
  const na = sa.match(NUM) ?? [];
  const nb = sb.match(NUM) ?? [];
  if (na.length !== nb.length) return false;
  if (sa.split(NUM).join('\0') !== sb.split(NUM).join('\0')) return false;
  return na.every((x, i) => {
    const p = Number(x);
    const q = Number(nb[i]);
    if (Object.is(p, q) || p === q) return true;
    return Math.abs(p - q) <= abs + rel * Math.max(Math.abs(p), Math.abs(q));
  });
}

function compareBytes(
  channel: string,
  rule: PolicyRules['stdout'],
  numeric: PolicyRules['numeric'],
  exp: Buffer,
  act: Buffer,
  out: CompareResult,
) {
  if (rule.mode === 'ignore') {
    out.not_compared.push(channel);
    return;
  }
  out.digests[channel] = { expected: sha256(exp), actual: sha256(act) };
  const rawEqual = exp.equals(act);
  if (!rawEqual) out.raw_equal = false;
  if (rawEqual) return;

  let e = exp;
  let a = act;
  let usedTolerance = false;
  if (rule.mode === 'normalized') {
    for (const n of rule.normalizers ?? []) {
      const ne = applyNormalizer(n, e);
      const na = applyNormalizer(n, a);
      out.normalization_trace.push({
        channel,
        normalizer: normalizerKey(n),
        changed_bytes_expected: Math.abs(e.length - ne.length) + countChanged(e, ne),
        changed_bytes_actual: Math.abs(a.length - na.length) + countChanged(a, na),
      });
      e = ne;
      a = na;
    }
  }
  if (e.equals(a)) {
    out.normalized = true;
    return;
  }
  // Tolerance applies only when the channel's mode is explicitly 'tolerance'; `exact` stays byte equality.
  if (rule.mode === 'tolerance' && numeric && numeric.applies_to === channel && toleranceEqual(e, a, numeric.abs, numeric.rel)) {
    out.normalized = true;
    usedTolerance = true;
    // Same bytes-that-differ count on both sides: tolerance does not rewrite either side.
    const changed = Math.abs(e.length - a.length) + countChanged(e, a);
    out.normalization_trace.push({ channel, normalizer: 'tolerance:decimal-v1', changed_bytes_expected: changed, changed_bytes_actual: changed, params: { abs: numeric.abs, rel: numeric.rel } });
  }
  if (usedTolerance) return;
  const fd = firstDifference(e, a)!;
  out.differences.push({
    channel,
    kind: 'content',
    first_difference: fd,
    expected_excerpt: excerpt(e, fd.byte),
    actual_excerpt: excerpt(a, fd.byte),
    expected_sha256: sha256(e),
    actual_sha256: sha256(a),
  });
}

function countChanged(a: Buffer, b: Buffer): number {
  let c = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) c++;
  return c;
}

function listFiles(d: ObservationData, include: RegExp[]) {
  const m = new Map<string, { status: string; sha256: string | null }>();
  for (const f of d.observation.files) if (include.some((r) => r.test(f.path))) m.set(f.path, { status: f.status, sha256: f.sha256 });
  return m;
}

/**
 * Compare a reference with an actual observation under a policy.
 * Invariants: no reference => needs_reference; incomplete actual => couldnt_run; match needs a complete observation on both sides;
 * a nondeterministic reference matches only if every varied channel has a non-exact rule.
 */
export function compare(policy: PolicyRules, reference: ObservationData | null, actual: ObservationData | null): CompareResult {
  const out: CompareResult = { outcome: 'match', ...empty() };
  for (const rule of [policy.stdout, policy.stderr]) {
    for (const n of rule.normalizers ?? []) {
      if (!hasNormalizer(n)) throw new Error(`unknown normalizer ${normalizerKey(n)}`);
    }
  }

  if (!reference) return { ...out, outcome: 'needs_reference' };
  if (!reference.observation.complete) return { ...out, outcome: 'needs_reference', diagnostics: { reason: 'reference_incomplete' } };

  if (!actual) return { ...out, outcome: 'couldnt_run', diagnostics: { phase: 'run', reason: 'no_observation' } };
  const tr = actual.observation.truncated;
  if (!actual.observation.complete || tr.stdout || tr.stderr || tr.files) {
    return { ...out, outcome: 'couldnt_run', diagnostics: { phase: 'run', reason: !actual.observation.complete ? 'incomplete_observation' : 'truncated_output' } };
  }

  if (reference.deterministic === false) {
    const modeOf: Record<string, string> = { stdout: policy.stdout.mode, stderr: policy.stderr.mode, exit: policy.exit.mode, files: policy.files.mode };
    const uncovered = (reference.varied_channels ?? Object.keys(modeOf)).filter((c) => modeOf[c] === 'exact');
    if (uncovered.length) {
      return { ...out, outcome: 'needs_reference', diagnostics: { reason: 'nondeterministic_reference', uncovered_channels: uncovered } };
    }
  }

  out.raw_equal = true;

  if (policy.exit.mode === 'ignore') out.not_compared.push('exit');
  else {
    const e = reference.observation.exit;
    const a = actual.observation.exit;
    if (e.code !== a.code || e.signal !== a.signal) {
      out.raw_equal = false;
      out.differences.push({ channel: 'exit', kind: 'value', expected: e.signal ?? e.code, actual: a.signal ?? a.code });
    }
  }

  compareBytes('stdout', policy.stdout, policy.numeric, reference.stdout, actual.stdout, out);
  compareBytes('stderr', policy.stderr, policy.numeric, reference.stderr, actual.stderr, out);

  if (policy.files.mode === 'ignore') out.not_compared.push('files');
  else {
    const inc = policy.files.include.map(globToRegExp);
    const ef = listFiles(reference, inc);
    const af = listFiles(actual, inc);
    for (const [p, e] of ef) {
      const a = af.get(p);
      if (!a) {
        out.raw_equal = false;
        out.differences.push({ channel: 'files', kind: 'missing', path: p });
      } else if (a.sha256 !== e.sha256 || a.status !== e.status) {
        out.raw_equal = false;
        const eb = reference.files[p] ?? Buffer.alloc(0);
        const ab = actual.files[p] ?? Buffer.alloc(0);
        out.differences.push({ channel: 'files', kind: 'content', path: p, first_difference: firstDifference(eb, ab), expected_status: e.status, actual_status: a.status });
      }
    }
    for (const p of af.keys()) {
      if (!ef.has(p)) {
        out.raw_equal = false;
        out.differences.push({ channel: 'files', kind: 'unexpected', path: p });
      }
    }
  }

  out.outcome = out.differences.length ? 'difference' : 'match';
  return out;
}
