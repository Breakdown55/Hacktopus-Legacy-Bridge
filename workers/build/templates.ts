/** Supervisor-written files. The model/customer writes only src/**; these never come from untrusted input. */
export const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist', rootDir: 'src', declaration: true, skipLibCheck: true, noEmitOnError: true, types: ['node'] },
  include: ['src/**/*.ts'],
}, null, 2) + '\n';

export const PACKAGE_JSON = JSON.stringify({ name: 'lb-module', version: '1.0.0', private: true, type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts', bin: { 'lb-cli': 'bin/cli.mjs' }, devDependencies: { typescript: '*', '@types/node': '*' } }, null, 2) + '\n';

/** Maps process I/O to the typed run(input, deps) interface. Verification and replay run this shim, same as for the original. */
export const CLI_SHIM = `#!/usr/bin/env node
import { run } from '../dist/index.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks);

let seed = Number(process.env.LB_SEED ?? 1) >>> 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const fixed = process.env.LB_FAKE_NOW ? new Date(process.env.LB_FAKE_NOW) : null;
const deps = { now: () => (fixed ? new Date(fixed) : new Date()), random, cwd: process.cwd(), env: { ...process.env } };

try {
  const out = await run({ argv: process.argv.slice(2), stdin, env: { ...process.env } }, deps);
  if (out.stdout != null) process.stdout.write(out.stdout);
  if (out.stderr != null) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode ?? 0;
} catch (e) {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\\n');
  process.exitCode = 70;
}
`;

/** `severity` is absent on compiler errors. Marker cross-check findings are warnings and never fail a build. */
export interface Diagnostic { file: string | null; line: number | null; code: string; message: string; severity?: 'warning' }

/** Cross-checks LB-UNTRANSLATED / LB-BEHAVIOR markers (plan §6.3) against the recorded list and the approved scope's behaviors. */
export function markerWarnings(files: { path: string; content: string }[], untranslated: { id: string; behavior_id?: string; behaviorId?: string }[], behaviorIds: string[]): Diagnostic[] {
  const found = new Map<string, { file: string; line: number }>();
  const addressed = new Set<string>();
  for (const f of files) f.content.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/LB-UNTRANSLATED:([\w.-]+)/g)) if (!found.has(m[1])) found.set(m[1], { file: f.path, line: i + 1 });
    for (const m of text.matchAll(/LB-BEHAVIOR:([\w.-]+)/g)) addressed.add(m[1]);
  });
  const listed = new Set(untranslated.map((u) => u.id));
  const out: Diagnostic[] = [];
  for (const [id, at] of found) if (!listed.has(id)) out.push({ ...at, code: 'LB_UNLISTED_MARKER', message: `Marker LB-UNTRANSLATED:${id} is not in the untranslated list.`, severity: 'warning' });
  for (const u of untranslated) if (!found.has(u.id)) out.push({ file: null, line: null, code: 'LB_MISSING_MARKER', message: `Untranslated item ${u.id} has no LB-UNTRANSLATED marker in the code.`, severity: 'warning' });
  const declared = new Set(untranslated.map((u) => u.behavior_id ?? u.behaviorId).filter(Boolean));
  for (const b of behaviorIds) if (!addressed.has(b) && !declared.has(b)) out.push({ file: null, line: null, code: 'LB_UNADDRESSED_BEHAVIOR', message: `Scope behavior ${b} has no LB-BEHAVIOR marker and is not listed as untranslated.`, severity: 'warning' });
  return out;
}

/** Parses \`tsc --pretty false\` output lines: src/index.ts(12,5): error TS2322: message */
export function parseTscDiagnostics(out: string): Diagnostic[] {
  const d: Diagnostic[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/);
    if (m) d.push({ file: m[1], line: Number(m[2]), code: m[4], message: m[5].slice(0, 500) });
    else { const g = line.match(/^error (TS\d+): (.*)$/); if (g) d.push({ file: null, line: null, code: g[1], message: g[2].slice(0, 500) }); }
  }
  return d;
}
