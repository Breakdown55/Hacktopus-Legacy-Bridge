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
const policy = (r: object = {}) => PolicyRules.parse({ engine: '1.0.0', ...r });
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
    expect(compare(p, obs('total 3.14\n'), obs('total 3.141\n')).outcome).toBe('match');
    expect(compare(p, obs('total 3.14\n'), obs('total 3.2\n')).outcome).toBe('difference');
    expect(compare(p, obs('total 3.14\n'), obs('sum 3.14\n')).outcome).toBe('difference');
    expect(toleranceEqual(Buffer.from('1 2'), Buffer.from('1'), 1, 0)).toBe(false);
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
});
