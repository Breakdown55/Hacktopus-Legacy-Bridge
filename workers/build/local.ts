import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { CLI_SHIM, PACKAGE_JSON, TSCONFIG, parseTscDiagnostics, type Diagnostic } from './templates';

export interface BuildOutput { status: 'succeeded' | 'failed' | 'error'; diagnostics: Diagnostic[]; log: string; files: { path: string; content: Buffer }[]; toolchain: Record<string, string>; image: string }

/** Local tsc build. UNSANDBOXED: dev/test only (the production build runs in the lb-node-build image under the sandbox). */
export async function localBuild(files: { path: string; content: Buffer }[], opts: { repoRoot?: string; timeoutMs?: number } = {}): Promise<BuildOutput> {
  const root = opts.repoRoot ?? process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'lb-build-'));
  try {
    for (const f of files) { const p = join(dir, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
    writeFileSync(join(dir, 'package.json'), PACKAGE_JSON);
    mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, 'bin/cli.mjs'), CLI_SHIM);
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules')); // for @types/node only; excluded from output
    const tscVersion = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version as string;
    const toolchain = { node: process.version, typescript: tscVersion };
    const image = `local-tsc@${tscVersion}`;
    const r = await new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolve) => {
      const c = spawn(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--pretty', 'false'], { cwd: dir, env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv });
      let out = ''; let timedOut = false;
      const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, opts.timeoutMs ?? 120_000);
      c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
      c.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: String(e), timedOut }); });
      c.on('close', (code) => { clearTimeout(t); resolve({ code, out, timedOut }); });
    });
    const diagnostics = parseTscDiagnostics(r.out);
    if (r.timedOut || r.code === null) return { status: 'error', diagnostics, log: r.out.slice(0, 20000), files: [], toolchain, image };
    if (r.code !== 0) return { status: 'failed', diagnostics, log: r.out.slice(0, 20000), files: [], toolchain, image };
    const out: { path: string; content: Buffer }[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push({ path: relative(dir, p).split('\\').join('/'), content: readFileSync(p) }); } };
    walk(join(dir, 'dist'));
    out.push({ path: 'bin/cli.mjs', content: Buffer.from(CLI_SHIM) }, { path: 'package.json', content: Buffer.from(PACKAGE_JSON) });
    return { status: 'succeeded', diagnostics, log: r.out.slice(0, 20000), files: out, toolchain, image };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
