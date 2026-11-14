import { describe, expect, it } from 'vitest';
import { classify, inspectElf, type RunImage } from '../../workers/analysis/builtin-elf/parse';
import { buildElf } from '../helpers/elf';

const image: RunImage = { libraries: ['libc.so.6', 'libm.so.6'], glibc: '2.36' };
const ctx = { suppliedLibraries: [], image, executionEnabled: true, consent: true };

describe('builtin ELF inspector', () => {
  it('parses header, PT_INTERP, DT_NEEDED, hardening, sections', () => {
    const i = inspectElf(buildElf({ needed: ['libc.so.6', 'libm.so.6'] }));
    expect(i).toMatchObject({ format: 'ELF64', arch: 'x86-64', type: 'ET_DYN', interpreter: '/lib64/ld-linux-x86-64.so.2', linking: 'dynamic', stripped: true });
    expect(i.needed).toEqual(['libc.so.6', 'libm.so.6']);
    expect(i.hardening).toEqual({ pie: true, nx: true, relro: 'full' });
    expect(i.sections.map((s) => s.name)).toContain('.shstrtab');
  });
  it('detects symtab, partial relro and static', () => {
    const i = inspectElf(buildElf({ symtab: true, bindNow: false, interp: null, needed: [], type: 2 }));
    expect(i).toMatchObject({ stripped: false, linking: 'dynamic', type: 'ET_EXEC' }); // PT_DYNAMIC present
    expect(i.hardening?.relro).toBe('partial');
  });
  it('extracts strings and max glibc requirement', () => {
    const i = inspectElf(buildElf({ extraStrings: ['hello world', 'GLIBC_2.34', 'GLIBC_2.2.5'] }));
    expect(i.strings.some((s) => s.value === 'hello world')).toBe(true);
    expect(i.max_glibc).toBe('2.34');
  });
  it('identifies non-ELF formats without executing', () => {
    expect(inspectElf(Buffer.from('MZ\x90\x00'.padEnd(80, '\0'))).format).toBe('PE');
    expect(inspectElf(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])).format).toBe('MachO');
    expect(inspectElf(Buffer.from('#!/bin/sh\necho')).format).toBe('script');
    expect(inspectElf(Buffer.from('random')).format).toBe('unknown');
  });
  it('is robust to truncated/garbage ELF', () => {
    const b = buildElf();
    for (const n of [20, 64, 100, b.length - 10]) expect(() => inspectElf(b.subarray(0, n))).not.toThrow();
  });
});

describe('eligibility', () => {
  it('eligible, execution unknown pending probe', () => {
    expect(classify(inspectElf(buildElf()), ctx)).toEqual({ analysis: 'eligible', execution: 'unknown', reasons: ['probe_not_run'] });
  });
  it('missing library => not_runnable before any run', () => {
    expect(classify(inspectElf(buildElf({ needed: ['libfoo.so.1'] })), ctx)).toMatchObject({ analysis: 'eligible', execution: 'not_runnable', reasons: ['missing_library:libfoo.so.1'] });
    expect(classify(inspectElf(buildElf({ needed: ['libfoo.so.1'] })), { ...ctx, suppliedLibraries: ['libfoo.so.1'] }).execution).toBe('unknown');
  });
  it('other arch is analysis-only', () => {
    expect(classify(inspectElf(buildElf({ machine: 0xb7 })), ctx)).toMatchObject({ analysis: 'partial', execution: 'unsupported', reasons: ['arch:aarch64'] });
  });
  it('newer glibc unsupported', () => {
    expect(classify(inspectElf(buildElf({ extraStrings: ['GLIBC_2.38'] })), ctx).execution).toBe('unsupported');
  });
  it('execution gating is separate from analysis', () => {
    expect(classify(inspectElf(buildElf()), { ...ctx, executionEnabled: false })).toMatchObject({ analysis: 'eligible', execution: 'not_permitted', reasons: ['execution_disabled'] });
    expect(classify(inspectElf(buildElf()), { ...ctx, consent: false }).reasons).toEqual(['consent_missing']);
  });
  it('PE/Mach-O/script are ineligible and never executed', () => {
    expect(classify(inspectElf(Buffer.from('MZ'.padEnd(80, '\0'))), ctx)).toEqual({ analysis: 'ineligible', execution: 'unsupported', reasons: ['format:pe'] });
  });
});
