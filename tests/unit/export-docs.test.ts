import { describe, expect, it } from 'vitest';
import { zip } from '../../workers/export/zip';
import { moduleDocs } from '../../workers/export/docs';

// DOS time of the first entry's local header, read straight from the archive bytes.
const stamp = (z: Buffer) => ({ time: z.readUInt16LE(10), date: z.readUInt16LE(12) });

describe('zip timestamps', () => {
  it('stores the given time (UTC) instead of 1980-01-01', () => {
    const { time, date } = stamp(zip([{ path: 'a', content: Buffer.from('x') }], new Date('2026-11-15T10:41:06Z')));
    expect({ year: (date >> 9) + 1980, month: (date >> 5) & 15, day: date & 31, hour: time >> 11, minute: (time >> 5) & 63 }).toEqual({ year: 2026, month: 11, day: 15, hour: 10, minute: 41 });
  });
  it('is deterministic for the same time, and falls back to 1980 without one', () => {
    const files = [{ path: 'b', content: Buffer.from('2') }, { path: 'a', content: Buffer.from('1') }];
    const at = new Date('2026-01-02T03:04:05Z');
    expect(zip(files, at).equals(zip([...files].reverse(), at))).toBe(true);
    expect((stamp(zip(files)).date >> 9) + 1980).toBe(1980);
  });
});

describe('docs.md', () => {
  const scope = { workflow: { name: 'calc', invocation: { argv_template: [], stdin: 'none' } },
    behaviors: [{ id: 'b1', label: 'Add', statement: 'Keep the behavior of add.', basis: 'inferred', evidence: [], notes: '' }] } as never;
  const files = [
    { path: 'src/index.ts', content: '/* LB-BEHAVIOR:b1 */\n/**\n * Adds two numbers and wraps like a 32-bit int.\n */\nexport function add(a: number, b: number): number {\n  return (a + b) | 0;\n}\n\nexport function bare(): void {}\n' },
    { path: 'src/helper.py', content: 'def helper(x):\n    """Doubles x."""\n    return x * 2\n' },
  ];
  const docs = moduleDocs({ project: 'demo', language: 'TypeScript', entry: 'src/index.ts', symbol: 'run', scope, untranslated: [{ id: 'overflow', behavior_id: 'b1', reason: 'wraps differently' }], files });
  it('documents every function with its comment, location and the feature it implements', () => {
    expect(docs).toContain('## Functions (3)');
    expect(docs).toMatch(/### `add`[\s\S]*src\/index\.ts:5[\s\S]*Adds two numbers and wraps like a 32-bit int\.[\s\S]*Implements: Add\./);
    expect(docs).toMatch(/### `helper`[\s\S]*Doubles x\./);
  });
  it('says so when a function has no comment, lists untranslated items, and is stable', () => {
    expect(docs).toMatch(/### `bare`[\s\S]*No comment was written/);
    expect(docs).toContain('**overflow** (Add): wraps differently');
    expect(docs).toBe(moduleDocs({ project: 'demo', language: 'TypeScript', entry: 'src/index.ts', symbol: 'run', scope, untranslated: [{ id: 'overflow', behavior_id: 'b1', reason: 'wraps differently' }], files }));
  });
});
