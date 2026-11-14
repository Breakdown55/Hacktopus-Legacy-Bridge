import { describe, expect, it } from 'vitest';
import { localBuild } from '../../workers/build/local';
import { parseTscDiagnostics } from '../../workers/build/templates';
import { findDisallowedImports, validateModuleFiles } from '../../server/domain/modules';
import { packTar, unpackTar } from '../../server/tar';

describe('tar', () => {
  it('round-trips and is deterministic', () => {
    const f = [{ path: 'b.txt', content: Buffer.from('bb') }, { path: 'a/x.ts', content: Buffer.alloc(600, 1) }];
    const t = packTar(f);
    expect(t.equals(packTar([...f].reverse()))).toBe(true);
    expect(unpackTar(t).map((x) => [x.path, x.content.length])).toEqual([['a/x.ts', 600], ['b.txt', 2]]);
  });
});

describe('module validation', () => {
  it('flags non-node imports', () => {
    const bad = findDisallowedImports(`import fs from 'node:fs'; import { a } from './a.js'; import x from 'lodash'; const y = require('left-pad'); export * from 'zod'; await import('evil')`);
    expect(bad.sort()).toEqual(['evil', 'left-pad', 'lodash', 'zod']);
  });
  it('rejects traversal, wrong dirs, missing entry, bad imports', () => {
    const ok = [{ path: 'src/index.ts', content: 'export const run = async () => ({})' }];
    expect(() => validateModuleFiles(ok)).not.toThrow();
    expect(() => validateModuleFiles([{ path: '../x.ts', content: '' }])).toThrow(/Unsafe/);
    expect(() => validateModuleFiles([{ path: 'package.json', content: '{}' }, ...ok])).toThrow(/src\/\*\*/);
    expect(() => validateModuleFiles([{ path: 'src/a.ts', content: '' }])).toThrow(/index.ts/);
    expect(() => validateModuleFiles([{ path: 'src/index.ts', content: "import x from 'lodash'" }])).toThrow(/Non-node/);
  });
});

describe('tsc build', () => {
  it('parses diagnostics', () => {
    expect(parseTscDiagnostics("src/index.ts(12,5): error TS2322: Type 'string' is not assignable.\nerror TS5083: bad")).toEqual([
      { file: 'src/index.ts', line: 12, code: 'TS2322', message: "Type 'string' is not assignable." }, { file: null, line: null, code: 'TS5083', message: 'bad' }]);
  });
  it('builds a valid module and reports failures', async () => {
    const good = await localBuild([{ path: 'src/index.ts', content: Buffer.from("export async function run(input: { stdin: Uint8Array }) { return { stdout: 'n=' + input.stdin.length + '\\n' }; }\n") }]);
    expect(good.status).toBe('succeeded');
    expect(good.files.map((f) => f.path)).toEqual(expect.arrayContaining(['dist/index.js', 'bin/cli.mjs', 'package.json']));
    const bad = await localBuild([{ path: 'src/index.ts', content: Buffer.from("export const run: number = 'x';\n") }]);
    expect(bad.status).toBe('failed');
    expect(bad.diagnostics[0]).toMatchObject({ file: 'src/index.ts', code: 'TS2322' });
  }, 60_000);
});
