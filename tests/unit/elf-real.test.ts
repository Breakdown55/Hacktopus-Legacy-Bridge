import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { classify, inspectElf } from '../../workers/analysis/builtin-elf/parse';

const bin = (n: string) => `${__dirname}/../../fixtures/bin/${n}`;
const have = existsSync(bin('wordfreq')) && existsSync(bin('wordfreq.stripped'));
const image = { libraries: ['libc.so.6', 'libm.so.6'], glibc: '2.36' };

describe.skipIf(!have)('real gcc-built ELF fixtures (run `make -C fixtures`)', () => {
  it('unstripped wordfreq', () => {
    const i = inspectElf(readFileSync(bin('wordfreq')));
    expect(i).toMatchObject({ format: 'ELF64', arch: 'x86-64', interpreter: '/lib64/ld-linux-x86-64.so.2', linking: 'dynamic', stripped: false });
    expect(i.needed).toEqual(['libc.so.6']);
    expect(i.sections.map((s) => s.name)).toEqual(expect.arrayContaining(['.text', '.symtab', '.dynamic']));
    expect(i.strings.some((s) => s.value.includes('usage: wordfreq'))).toBe(true);
  });
  it('stripped wordfreq', () => {
    const i = inspectElf(readFileSync(bin('wordfreq.stripped')));
    expect(i.stripped).toBe(true);
    expect(i.needed).toEqual(['libc.so.6']);
  });
  it('eligibility against run image', () => {
    const i = inspectElf(readFileSync(bin('wordfreq')));
    expect(classify(i, { suppliedLibraries: [], image, executionEnabled: true, consent: true })).toMatchObject({ analysis: 'eligible', execution: 'unknown' });
  });
});
