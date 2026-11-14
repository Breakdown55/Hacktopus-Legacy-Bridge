/**
 * Pipe-based case runner (§7.2). Runs a target with exact argv, a clean env, byte-exact stdin and separate
 * stdout/stderr. Observes exit, signal, truncation and file effects under the working directory.
 * Isolation (gVisor, network=none, limits) is the sandbox launcher's job; this runs *inside* it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Observation } from '@lb/contracts';
import type { ObservationData } from '@lb/compare';

export const LIMITS = { outputCap: 8 * 1024 * 1024, maxDepth: 8, maxEntries: 1000, hashBudget: 64 * 1024 * 1024 };

export interface RunRequest {
  command: string;
  args: string[];
  /** Allow-listed controls (TZ, LC_ALL, LD_PRELOAD...) merged under case.env; nothing is inherited from the host. */
  controlEnv: Record<string, string>;
  caseEnv: Record<string, string>;
  stdin: Buffer;
  files: { path: string; content: Buffer; mode: string }[];
  workdir: string;
  timeoutMs: number;
  outputCap?: number;
}

export interface RunOutcome {
  data: ObservationData;
  /** Reason the observation is incomplete (timeout, spawn failure...). Absent when complete. */
  incomplete?: { reason: 'timeout' | 'spawn_error' | 'output_cap'; detail?: string };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function safeJoin(root: string, p: string): string {
  const full = join(root, p);
  const rel = relative(root, full);
  if (rel.startsWith('..') || rel.startsWith(sep) || p.startsWith('/')) throw new Error(`path escapes workdir: ${p}`);
  return full;
}

type Snap = Map<string, { size: number; mtimeMs: number }>;
function walk(root: string): { snap: Snap; truncated: boolean } {
  const snap: Snap = new Map();
  let truncated = false;
  const rec = (dir: string, depth: number) => {
    if (depth > LIMITS.maxDepth) { truncated = true; return; }
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (snap.size >= LIMITS.maxEntries) { truncated = true; return; }
      const full = join(dir, e.name);
      if (e.isDirectory()) rec(full, depth + 1);
      else if (e.isFile()) { const s = statSync(full); snap.set(relative(root, full).split(sep).join('/'), { size: s.size, mtimeMs: s.mtimeMs }); }
    }
  };
  rec(root, 0);
  return { snap, truncated };
}

export async function runCase(req: RunRequest): Promise<RunOutcome> {
  const cap = req.outputCap ?? LIMITS.outputCap;
  mkdirSync(req.workdir, { recursive: true });
  for (const f of req.files) {
    const full = safeJoin(req.workdir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    chmodSync(full, parseInt(f.mode, 8));
  }
  const contentBefore = new Map<string, string>();
  const before = walk(req.workdir);
  let budget = LIMITS.hashBudget;
  for (const [p, m] of before.snap) { if (budget >= m.size) { budget -= m.size; contentBefore.set(p, sha(readFileSync(join(req.workdir, p)))); } }

  const started = Date.now();
  const out: Buffer[] = [], err: Buffer[] = [];
  let outLen = 0, errLen = 0, truncOut = false, truncErr = false;
  let incomplete: RunOutcome['incomplete'];
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };

  await new Promise<void>((resolve) => {
    const child = spawn(req.command, req.args, { cwd: req.workdir, env: { ...req.controlEnv, ...req.caseEnv } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { incomplete ??= { reason: 'timeout' }; child.kill('SIGKILL'); }, req.timeoutMs);
    const take = (arr: Buffer[], chunk: Buffer, len: number) => {
      const room = Math.max(0, cap - len);
      arr.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      return chunk.length > room;
    };
    child.stdout.on('data', (c: Buffer) => { if (take(out, c, outLen)) { truncOut = true; incomplete ??= { reason: 'output_cap' }; child.kill('SIGKILL'); } outLen += c.length; });
    child.stderr.on('data', (c: Buffer) => { if (take(err, c, errLen)) { truncErr = true; incomplete ??= { reason: 'output_cap' }; child.kill('SIGKILL'); } errLen += c.length; });
    child.stdin.on('error', () => {}); // target may exit without reading stdin (EPIPE) - an observation, not an error
    child.stdin.end(req.stdin);
    child.on('error', (e) => { incomplete ??= { reason: 'spawn_error', detail: (e as Error).message }; clearTimeout(timer); resolve(); });
    child.on('close', (code, signal) => { clearTimeout(timer); exit = { code, signal }; resolve(); });
  });

  const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
  const after = walk(req.workdir);
  const files: Observation['files'] = [];
  const bytes: Record<string, Buffer> = {};
  budget = LIMITS.hashBudget;
  let filesTruncated = before.truncated || after.truncated;
  for (const [p, m] of [...after.snap].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const prev = contentBefore.get(p);
    const wasThere = before.snap.has(p);
    if (wasThere && prev !== undefined && before.snap.get(p)!.size === m.size && before.snap.get(p)!.mtimeMs === m.mtimeMs) continue;
    if (budget < m.size) { filesTruncated = true; continue; }
    budget -= m.size;
    const content = readFileSync(join(req.workdir, p));
    const h = sha(content);
    if (wasThere && prev === h) continue;
    bytes[p] = content;
    files.push({ path: p, status: wasThere ? 'modified' : 'created', sha256: h, size: content.length });
  }
  for (const p of before.snap.keys()) if (!after.snap.has(p)) files.push({ path: p, status: 'deleted', sha256: null, size: 0 });

  const observation: Observation = {
    exit,
    stdout: { sha256: sha(stdout), size: stdout.length },
    stderr: { sha256: sha(stderr), size: stderr.length },
    files,
    truncated: { stdout: truncOut, stderr: truncErr, files: filesTruncated },
    resources: { wall_ms: Date.now() - started },
    complete: !incomplete,
  };
  return { data: { observation, stdout, stderr, files: bytes }, incomplete };
}
