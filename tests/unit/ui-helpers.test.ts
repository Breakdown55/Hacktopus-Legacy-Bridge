import { moduleFunctions, simpleQuestion } from '../../lib/module-preview';
import { describe, expect, it } from 'vitest';
import { detectExecutable } from '../../lib/executable';
import { approvalBlockers, emptyScope, openQuestions, prune, type Scope } from '../../lib/scope-doc';

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('detectExecutable (import gate for the browser UI)', () => {
  it('accepts ELF, PE and Mach-O', () => {
    expect(detectExecutable(bytes(0x7f, 0x45, 0x4c, 0x46))).toBe('ELF');
    expect(detectExecutable(bytes(0x4d, 0x5a, 0x90, 0x00))).toBe('PE');
    expect(detectExecutable(bytes(0xcf, 0xfa, 0xed, 0xfe))).toBe('Mach-O');
    expect(detectExecutable(bytes(0xfe, 0xed, 0xfa, 0xce))).toBe('Mach-O');
  });
  it('rejects text, scripts, archives, images and empty files', () => {
    expect(detectExecutable(new TextEncoder().encode('hello world'))).toBeNull();
    expect(detectExecutable(new TextEncoder().encode('#!/bin/sh\n'))).toBeNull();
    expect(detectExecutable(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull(); // zip
    expect(detectExecutable(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // png
    expect(detectExecutable(bytes())).toBeNull();
    expect(detectExecutable(bytes(0x7f, 0x45))).toBeNull(); // truncated ELF magic
  });
});

describe('scope document helpers', () => {
  it('an empty scope is not approvable; a scope with a stated behavior is', () => {
    expect(approvalBlockers(emptyScope('w'))).toEqual(['Add at least one behavior to modernize.']);
    const ready: Scope = { ...emptyScope('w'), behaviors: [{ id: 'b', statement: 'Counts words', basis: 'observed', evidence: [] }] };
    expect(approvalBlockers(ready)).toEqual([]);
    expect(approvalBlockers({ ...ready, behaviors: [{ id: 'b', statement: '  ', basis: 'observed', evidence: [] }] })).toEqual(['Every behavior needs a statement.']);
  });
  it('prune drops blank rows but keeps evidence-only behaviors', () => {
    const doc: Scope = {
      ...emptyScope('w'),
      behaviors: [{ id: 'a', statement: '', basis: 'observed', evidence: [] }, { id: 'b', statement: '', basis: 'inferred', evidence: ['e1'] }],
      assumptions: [{ id: 'x', text: ' ' }, { id: 'y', text: 'ASCII only' }],
      open_questions: [{ id: 'q', text: '', status: 'open', resolution: null }],
    };
    const out = prune(doc);
    expect(out.behaviors?.map(b => b.id)).toEqual(['b']);
    expect(out.assumptions?.map(a => a.id)).toEqual(['y']);
    expect(out.open_questions).toEqual([]);
  });
  it('counts only unresolved questions', () => {
    const doc: Scope = { ...emptyScope('w'), open_questions: [{ id: '1', text: 'a', status: 'open', resolution: null }, { id: '2', text: 'b', status: 'resolved', resolution: 'x' }] };
    expect(openQuestions(doc)).toHaveLength(1);
  });
});


describe('replacement preview', () => {
  it('lists named functions for all targets without counting comments or example strings', () => {
    const files = [
      { path: 'src/index.ts', content: 'export async function run() {}\nconst count = (x: string) => x.length;\n// function fake() {}\nconst text = "function fakeToo() {}";' },
      { path: 'src/replacement.py', content: 'def run(args):\n  pass\n# def fake():' },
      { path: 'src/replacement.go', content: 'func Run(args []string) int { return 0 }' },
      { path: 'src/Replacement.java', content: 'public static int run(String[] args) throws Exception { return 0; }' },
      { path: 'src/Replacement.cs', content: 'public static int Run(string[] args) { return 0; }' },
    ];
    expect(moduleFunctions(files).map(f => f.name)).toEqual(['run', 'count', 'run', 'Run', 'run', 'Run']);
  });
  it('uses the model’s simple question and offers a readable fallback for existing code', () => {
    expect(simpleQuestion('int32 wraparound', 'What should happen for a very large total?')).toBe('What should happen for a very large total?');
    expect(simpleQuestion('Original wraps at 2^31')).toContain('very large number');
    expect(simpleQuestion('The opcode names are missing')).toContain('example input file');
    expect(simpleQuestion('No encoding for non-ASCII bytes')).toContain('special characters');
    expect(simpleQuestion('Missing record codes', 'What two letters at the start of a record mean that an account should be opened?')).toContain('example input file');
  });
});
