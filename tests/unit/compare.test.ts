import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PolicyRules, type Observation } from '@lb/contracts';
import { compare, globToRegExp, sha256, toleranceEqual, type ObservationData } from '@lb/compare';

const obs = (stdout: string, o: { code?: number; stderr?: string; complete?: boolean; truncated?: boolean; files?: Record<string, string> } = {}): ObservationData => {
  const so = Buffer.from(stdout, 'latin1');
  const se = Buffer.from(o.stderr ?? '', 'latin1');
  const files = Object.fromEntries(Object.entries(o.files ?? {}).map(([k, v]) => [k, Buffer.from(v)]));
  const observation: Observation = {
    exit: { code: o.code ?? 0, signal: null },
    stdout: { sha256: sha256(so), size: so.length },
    stderr: { sha256: sha256(se), size: se.length },
    files: Object.entries(files).map(([path, b]) => ({ path, status: 'created' as const, sha256: sha256(b), size: b.length })),
    truncated: { stdout: !!o.truncated, stderr: false, files: false },
    complete: o.complete ?? true,
  };
  return { observation, stdout: so, stderr: se, files };
};
const policy = (r: object = {}) => PolicyRules.parse({ engine: '1.1.0', ...r });
const exact = policy();

describe('outcomes', () => {
  it('match on identical', () => expect(compare(exact, obs('a 3\n'), obs('a 3\n')).outcome).toBe('match'));
  it('no reference -> needs_reference, never match', () => expect(compare(exact, null, obs('x')).outcome).toBe('needs_reference'));
  it('no actual -> couldnt_run', () => expect(compare(exact, obs('x'), null).outcome).toBe('couldnt_run'));
  it('truncated actual -> couldnt_run', () => expect(compare(exact, obs('x'), obs('x', { truncated: true })).outcome).toBe('couldnt_run'));
  it('incomplete actual -> couldnt_run', () => expect(compare(exact, obs('x'), obs('x', { complete: false })).outcome).toBe('couldnt_run'));
  it('nonzero exit is an observation and is compared', () => {
    const r = compare(exact, obs('x', { code: 0 }), obs('x', { code: 2 }));
    expect(r.outcome).toBe('difference');
    expect(r.differences[0]).toMatchObject({ channel: 'exit', expected: 0, actual: 2 });
  });
  it('locates first difference', () => {
    const r = compare(exact, obs('a 3\nb 2\nc 1\n'), obs('a 3\nb 2\nd 1\n'));
    expect(r.outcome).toBe('difference');
    expect(r.differences[0]).toMatchObject({ first_difference: { byte: 8, line: 3, column: 1 } });
  });
});

describe('policies', () => {
  const norm = policy({ stdout: { mode: 'normalized', normalizers: [{ id: 'line-endings', version: 1 }, { id: 'trailing-whitespace', version: 1 }] } });
  it('normalized match keeps raw_equal=false and a trace', () => {
    const r = compare(norm, obs('a \nb\n'), obs('a\r\nb\r\n'));
    expect(r.outcome).toBe('match');
    expect(r.raw_equal).toBe(false);
    expect(r.normalized).toBe(true);
    expect(r.normalization_trace.map((t) => t.normalizer)).toEqual(['line-endings@1', 'trailing-whitespace@1']);
  });
  it('normalizers do not hide real differences', () => expect(compare(norm, obs('a\n'), obs('b\n')).outcome).toBe('difference'));
  it('ignore channels are listed as not compared', () => {
    const p = policy({ stderr: { mode: 'ignore', reason: 'wording changed' } });
    const r = compare(p, obs('x', { stderr: 'old' }), obs('x', { stderr: 'new' }));
    expect(r.outcome).toBe('match');
    expect(r.not_compared).toEqual(['stderr']);
  });
  it('ignore requires reason', () => expect(() => policy({ stderr: { mode: 'ignore' } })).toThrow());
  it('tolerance on numerics', () => {
    const p = policy({ stdout: { mode: 'tolerance' }, numeric: { applies_to: 'stdout', tokenizer: 'decimal-v1', abs: 0.01, rel: 0 } });
    const exactWithNumeric = policy({ numeric: { applies_to: 'stdout', tokenizer: 'decimal-v1', abs: 0.01, rel: 0 } });
    expect(compare(exactWithNumeric, obs('3.14'), obs('3.141')).outcome).toBe('difference'); // exact is never loosened
    expect(() => policy({ stdout: { mode: 'tolerance' } })).toThrow();
    const tol = compare(p, obs('total 3.14\n'), obs('total 3.141\n'));
    expect(tol).toMatchObject({ outcome: 'match', raw_equal: false, normalized: true });
    expect(tol.normalization_trace).toEqual([{ channel: 'stdout', normalizer: 'tolerance:decimal-v1', changed_bytes_expected: 2, changed_bytes_actual: 2, params: { abs: 0.01, rel: 0 } }]);
    expect(compare(p, obs('total 3.14\n'), obs('total 3.2\n')).outcome).toBe('difference');
    expect(compare(p, obs('total 3.14\n'), obs('sum 3.14\n')).outcome).toBe('difference');
    expect(toleranceEqual(Buffer.from('1 2'), Buffer.from('1'), 1, 0)).toBe(false);
  });
  it('ignore on exit and files also requires a reason', () => {
    expect(() => policy({ exit: { mode: 'ignore' } })).toThrow(/reason/);
    expect(() => policy({ files: { include: [], mode: 'ignore', reason: '  ' } })).toThrow(/reason/);
    expect(() => policy({ stdout: { mode: 'ignore', reason: ' ' } })).toThrow(/reason/);
    expect(policy({ exit: { mode: 'ignore', reason: 'exit codes renumbered' } }).exit.mode).toBe('ignore');
  });
  it('normalizers are rejected unless mode is normalized (never silently dropped)', () => {
    const n = [{ id: 'line-endings', version: 1 }];
    expect(() => policy({ stdout: { mode: 'tolerance', normalizers: n }, numeric: { applies_to: 'stdout', tokenizer: 'decimal-v1', abs: 1, rel: 0 } })).toThrow(/normalizers are only allowed when mode is/);
    expect(() => policy({ stdout: { mode: 'exact', normalizers: n } })).toThrow(/normalized/);
    expect(() => policy({ stderr: { mode: 'ignore', reason: 'x', normalizers: n } })).toThrow(/normalized/);
  });
  it('files: missing, content, unexpected', () => {
    const p = policy({ files: { include: ['out/**'], mode: 'exact' } });
    expect(compare(p, obs('', { files: { 'out/a.csv': '1' } }), obs('', { files: { 'out/a.csv': '1' } })).outcome).toBe('match');
    expect(compare(p, obs('', { files: { 'out/a.csv': '1' } }), obs('')).differences[0]).toMatchObject({ kind: 'missing' });
    expect(compare(p, obs('', { files: { 'out/a.csv': '1' } }), obs('', { files: { 'out/a.csv': '2' } })).differences[0]).toMatchObject({ kind: 'content' });
    expect(compare(p, obs(''), obs('', { files: { 'out/b': '1' } })).differences[0]).toMatchObject({ kind: 'unexpected' });
    expect(compare(p, obs('', { files: { 'other/x': '1' } }), obs('')).outcome).toBe('match');
  });
  it('nondeterministic reference cannot match under exact', () => {
    const ref = { ...obs('x'), deterministic: false, varied_channels: ['stdout'] };
    expect(compare(exact, ref, obs('x')).outcome).toBe('needs_reference');
    const covered = policy({ stdout: { mode: 'ignore', reason: 'random' } });
    expect(compare(covered, ref, obs('y')).outcome).toBe('match');
  });
  it('unknown normalizer fails loudly', () => {
    const p = policy({ stdout: { mode: 'normalized', normalizers: [{ id: 'nope', version: 1 }] } });
    expect(() => compare(p, obs('a'), obs('a'))).toThrow(/unknown normalizer/);
  });
  it('glob', () => {
    expect(globToRegExp('out/**').test('out/a/b.txt')).toBe(true);
    expect(globToRegExp('out/*.csv').test('out/a/b.csv')).toBe(false);
    expect(globToRegExp('**/x').test('x')).toBe(true);
  });
});

describe('properties', () => {
  const s = fc.string({ unit: 'binary', maxLength: 64 });
  it('compare(x,x)=match', () => fc.assert(fc.property(s, (x) => compare(exact, obs(x), obs(x)).outcome === 'match')));
  it('single-byte mutation => difference (exact)', () =>
    fc.assert(fc.property(s.filter((x) => x.length > 0), fc.nat(), (x, i) => {
      const k = i % x.length;
      const y = x.slice(0, k) + String.fromCharCode((x.charCodeAt(k) + 1) & 0xff) + x.slice(k + 1);
      return compare(exact, obs(x), obs(y)).outcome === 'difference';
    })));
  it('symmetric under normalizers', () => {
    const p = policy({ stdout: { mode: 'normalized', normalizers: [{ id: 'line-endings', version: 1 }, { id: 'trailing-whitespace', version: 1 }] } });
    fc.assert(fc.property(s, s, (a, b) => compare(p, obs(a), obs(b)).outcome === compare(p, obs(b), obs(a)).outcome));
  });
  it('compare(x,x)=match for any complete untruncated observation (exit, stderr, files vary too)', () =>
    fc.assert(fc.property(s, s, fc.integer({ min: 0, max: 255 }), fc.dictionary(fc.constantFrom('out/a', 'out/b/c', 'other'), s, { maxKeys: 3 }), (so, se, code, files) => {
      const p = policy({ files: { include: ['out/**'], mode: 'exact' } });
      const x = obs(so, { stderr: se, code, files });
      const r = compare(p, x, obs(so, { stderr: se, code, files }));
      return r.outcome === 'match' && r.raw_equal === true && r.normalized === false && r.normalization_trace.length === 0;
    })));
  it('byte mutation at index i => difference whose first_difference.byte is exactly i', () =>
    fc.assert(fc.property(s.filter((x) => x.length > 0), fc.nat(), fc.integer({ min: 1, max: 255 }), (x, i, delta) => {
      const k = i % x.length;
      const y = x.slice(0, k) + String.fromCharCode((x.charCodeAt(k) + delta) & 0xff) + x.slice(k + 1);
      const r = compare(exact, obs(x), obs(y));
      return r.outcome === 'difference' && (r.differences[0] as { first_difference: { byte: number } }).first_difference.byte === k;
    })));
  it('a mutation fully covered by a declared normalizer matches with normalized=true and raw_equal=false', () => {
    const p = policy({ stdout: { mode: 'normalized', normalizers: [{ id: 'trailing-whitespace', version: 1 }] } });
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{0,10}$/), fc.stringMatching(/^[ \t]{1,5}$/), (base, pad) => {
      const r = compare(p, obs(base), obs(base + pad));
      return r.outcome === 'match' && r.normalized === true && r.raw_equal === false
        && r.normalization_trace.length === 1 && r.normalization_trace[0].changed_bytes_actual === pad.length;
    }));
  });
  describe('tolerance properties', () => {
    const abs = 0.5;
    const tol = policy({ stdout: { mode: 'tolerance' }, numeric: { applies_to: 'stdout', tokenizer: 'decimal-v1', abs, rel: 0 } });
    const base = fc.integer({ min: -1000, max: 1000 });
    it('perturbation within abs matches (raw differs, trace says tolerance); beyond abs differs', () =>
      fc.assert(fc.property(base, fc.integer({ min: 1, max: 49 }), fc.integer({ min: 51, max: 500 }), fc.boolean(), (n, inside, outside, neg) => {
        const sign = neg ? -1 : 1;
        const near = n + (sign * inside) / 100, far = n + (sign * outside) / 100;
        const m = compare(tol, obs(`v ${n}\n`), obs(`v ${near.toFixed(2)}\n`));
        const d = compare(tol, obs(`v ${n}\n`), obs(`v ${far.toFixed(2)}\n`));
        return m.outcome === 'match' && m.raw_equal === false && m.normalization_trace[0]?.normalizer === 'tolerance:decimal-v1' && d.outcome === 'difference';
      })));
    it('a different number of numeric tokens, or different text between them, differs', () =>
      fc.assert(fc.property(base, base, (a, b) => {
        const one = compare(tol, obs(`${a}\n`), obs(`${a} ${b}\n`)).outcome === 'difference';
        const text = compare(tol, obs(`x ${a}\n`), obs(`y ${a}\n`)).outcome === 'difference';
        return one && text;
      })));
  });
});
