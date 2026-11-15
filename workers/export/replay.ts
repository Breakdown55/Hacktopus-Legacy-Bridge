/**
 * Replay modes for the exported harness (bundled into harness/lib.mjs; Node builtins only).
 *   (default)  run the module on the host            -> run-cases.mjs itself
 *   --docker   build environment/Dockerfile.replacement and replay inside a hardened container (no network)
 *   --original recapture the cases from original/ in the original image and compare with the stored references
 * Nothing here ever writes a reference or touches results/.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PolicyRules } from '@lb/contracts';
import { compare, COMPARE_ENGINE_VERSION, type ObservationData } from '@lb/compare';
import { runCase, type RunOutcome, type RunRequest } from '../execution/harness';
import { hardeningArgs } from '../execution/runners';

export type ReplayMode = 'host' | 'docker' | 'original';
export interface ReplayArgs { mode: ReplayMode; out: string; docker: string }

/** Exit codes of the harness itself. 125/126/127 mirror docker's own and are reported distinctly. */
export const EXIT = { ok: 0, mismatch: 1, usage: 2, dockerFailed: 125, notExecutable: 126, notFound: 127 } as const;

export function parseReplayArgs(argv: string[], env: Record<string, string | undefined> = {}): ReplayArgs | { error: string } {
  const out: ReplayArgs = { mode: 'host', out: 'replay-report.json', docker: env.LB_DOCKER || env.DOCKER_BIN || 'docker' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docker' || a === '--original') {
      const mode: ReplayMode = a === '--docker' ? 'docker' : 'original';
      if (out.mode !== 'host' && out.mode !== mode) return { error: '--docker and --original cannot be combined' };
      out.mode = mode;
    } else if (a === '--out' || a === '--docker-bin') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      if (a === '--out') out.out = v; else out.docker = v;
    } else return { error: `unknown argument: ${a}` };
  }
  return out;
}

/** What docker's own exit statuses mean. Anything else came from the program inside the container. */
export function dockerFailure(status: number | null): { code: number; message: string } | null {
  if (status === 125) return { code: EXIT.dockerFailed, message: 'docker failed before the replay started (is the daemon running? did the build or image pull fail?)' };
  if (status === 126) return { code: EXIT.notExecutable, message: 'docker could not execute the command inside the container' };
  if (status === 127) return { code: EXIT.notFound, message: 'the command was not found inside the container' };
  return null;
}

const PINNED = /@sha256:[0-9a-f]{64}$/;
const err = (m: string) => process.stderr.write(m + '\n');
const rand = () => Math.random().toString(36).slice(2, 10);

export type Exec = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'error' | 'signal'>;
const defaultExec: Exec = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' });

function spawnFailure(e: Error & { code?: string }, docker: string): number {
  if (e.code === 'ENOENT') { err(`docker not found (${docker}). Install Docker or pass --docker-bin PATH.`); return EXIT.notFound; }
  err(`could not start docker: ${e.message}`);
  return EXIT.dockerFailed;
}

// ---------------- --docker ----------------
export const dockerBuildArgs = (root: string, tag: string, platform?: string) => ['build', ...(platform ? ['--platform', platform] : []), '-t', tag, '-f', join(root, 'environment/Dockerfile.replacement'), root];

/** The container runs integrity first, then the host-mode replay; the report goes to the bind-mounted /out. */
export function dockerRunArgs(a: { name: string; image: string; outDir: string; platform?: string }): string[] {
  return ['run', '--rm', ...hardeningArgs({ name: a.name, platform: a.platform }), '-v', `${a.outDir}:/out`, a.image, 'sh', '-c',
    'node harness/verify-integrity.mjs && node harness/run-cases.mjs --out /out/replay-report.json'];
}

export function replayInDocker(root: string, o: ReplayArgs, exec: Exec = defaultExec): number {
  const dockerfile = join(root, 'environment/Dockerfile.replacement');
  if (!existsSync(dockerfile)) { err('environment/Dockerfile.replacement is missing from this package'); return EXIT.usage; }
  const from = readFileSync(dockerfile, 'utf8').split('\n').map((l) => l.trim()).find((l) => /^FROM\s/i.test(l));
  if (!from || !PINNED.test(from)) { err('Dockerfile.replacement must start from an image pinned by digest (FROM name@sha256:...)'); return EXIT.usage; }

  const tag = `lb-replay:${rand()}`;
  const platform = existsSync(join(root, 'environment/replacement-command.json')) ? 'linux/amd64' : undefined;
  const build = exec(o.docker, dockerBuildArgs(root, tag, platform));
  if (build.error) return spawnFailure(build.error, o.docker);
  if (build.status !== 0) { err('docker build failed'); return EXIT.dockerFailed; }

  const outDir = mkdtempSync(join(tmpdir(), 'lb-replay-out-'));
  chmodSync(outDir, 0o777); // the container user is not the host user
  try {
    const run = exec(o.docker, dockerRunArgs({ name: `lb-replay-${rand()}`, image: tag, outDir, platform }));
    if (run.error) return spawnFailure(run.error, o.docker);
    const failure = dockerFailure(run.status);
    if (failure) { err(failure.message); return failure.code; }
    const report = join(outDir, 'replay-report.json');
    if (existsSync(report)) copyFileSync(report, o.out);
    return run.status ?? EXIT.mismatch;
  } finally {
    exec(o.docker, ['rmi', '-f', tag]);
  }
}

// ---------------- --original ----------------
const STRICT: PolicyRules = { engine: COMPARE_ENGINE_VERSION, exit: { mode: 'exact' }, stdout: { mode: 'exact' }, stderr: { mode: 'exact' }, files: { include: ['**'], mode: 'exact' } };

export function originalBinary(root: string): { name: string; hasLibs: boolean } | { error: string } {
  const bin = join(root, 'original/bin');
  const names = existsSync(bin) ? readdirSync(bin).sort() : [];
  if (!names.length) return { error: 'This package has no original binary (original/bin is absent): it was exported without include_original_binary. Re-export with the original included, or use the default replay.' };
  let primary: string | undefined;
  try { primary = basename(JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8')).binding?.source_revision?.primary?.path ?? ''); } catch { /* fall back below */ }
  return { name: primary && names.includes(primary) ? primary : names[0], hasLibs: existsSync(join(root, 'original/lib')) };
}

/** Same container hardening as the product's DockerOriginalRunner: the shared hardeningArgs. */
export function originalRunArgs(a: { name: string; image: string; originalDir: string; workdir: string; binary: string; hasLibs: boolean; caseEnv: Record<string, string>; argv: string[] }): string[] {
  const env = { TZ: 'UTC', LC_ALL: 'C.UTF-8', HOME: '/tmp', ...(a.hasLibs ? { LD_LIBRARY_PATH: '/opt/legacy/lib' } : {}), ...a.caseEnv };
  return ['run', '--rm', '-i', ...hardeningArgs({ name: a.name, platform: 'linux/amd64' }), '-v', `${a.originalDir}:/opt/legacy:ro`, '-v', `${a.workdir}:/work`, '-w', '/work',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), a.image, `/opt/legacy/bin/${a.binary}`, ...a.argv];
}

function loadReference(dir: string, deterministic: boolean | undefined, varied: string[] | undefined): ObservationData {
  const observation = JSON.parse(readFileSync(join(dir, 'reference/observation.json'), 'utf8'));
  const readIf = (p: string) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  const files: Record<string, Buffer> = {};
  for (const f of observation.files) if (f.blob) files[f.path] = readFileSync(join(dir, 'reference/files', f.path));
  return { observation, stdout: readIf(join(dir, 'reference/stdout.bin')), stderr: readIf(join(dir, 'reference/stderr.bin')), files, deterministic, varied_channels: varied };
}

export type OriginalStatus = 'same' | 'different' | 'nondeterministic' | 'couldnt_run' | 'skipped';

export async function replayOriginal(root: string, o: ReplayArgs, deps: { run?: (r: RunRequest) => Promise<RunOutcome>; workdir?: () => string } = {}): Promise<number> {
  const bin = originalBinary(root);
  if ('error' in bin) { err(bin.error); return EXIT.usage; }
  let image: string | undefined;
  try { image = JSON.parse(readFileSync(join(root, 'environment/environment.json'), 'utf8')).original?.[0]?.image; } catch { /* handled below */ }
  if (!image || !PINNED.test(image)) { err('environment/environment.json has no original image pinned by digest, so the original cannot be run.'); return EXIT.usage; }

  // Zip archives and some extractors drop the executable bit, and the mount is read-only: stage a copy with bin/* executable.
  const staged = mkdtempSync(join(tmpdir(), 'lb-orig-bin-'));
  cpSync(join(root, 'original'), staged, { recursive: true });
  chmodSync(staged, 0o755);
  for (const sub of ['bin', 'lib']) {
    const d = join(staged, sub);
    if (!existsSync(d)) continue;
    chmodSync(d, 0o755);
    for (const f of readdirSync(d)) chmodSync(join(d, f), sub === 'bin' ? 0o755 : 0o644);
  }

  const run = deps.run ?? runCase;
  const mkWorkdir = deps.workdir ?? (() => { const d = mkdtempSync(join(tmpdir(), 'lb-orig-')); chmodSync(d, 0o777); return d; });
  const statuses: Record<string, { status: OriginalStatus; outcome?: string; detail?: unknown }> = {};
  for (const id of readdirSync(join(root, 'cases')).sort()) {
    const dir = join(root, 'cases', id);
    if (!existsSync(join(dir, 'reference/observation.json'))) { statuses[id] = { status: 'skipped', detail: 'no reference' }; continue; }
    const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'));
    const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    const ref = loadReference(dir, prov.deterministic ?? undefined, prov.variance?.channels);
    const workdir = mkWorkdir();
    const args = originalRunArgs({ name: `lb-orig-${rand()}`, image, originalDir: staged, workdir, binary: bin.name, hasLibs: bin.hasLibs, caseEnv: input.env ?? {}, argv: input.argv });
    const files = (input.files ?? []).map((f: { path: string; mode: string }) => ({ path: f.path, mode: f.mode, content: readFileSync(join(dir, 'files', f.path)) }));
    const stdinPath = join(dir, 'stdin.bin');
    let outcome: RunOutcome;
    try {
      outcome = await run({ command: o.docker, args, controlEnv: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, caseEnv: {}, stdin: existsSync(stdinPath) ? readFileSync(stdinPath) : Buffer.alloc(0), files, workdir, timeoutMs: input.timeout_ms ?? 10_000 });
    } catch (e) { statuses[id] = { status: 'couldnt_run', detail: String((e as Error).message).slice(0, 200) }; continue; }
    if (outcome.incomplete) { statuses[id] = { status: 'couldnt_run', detail: outcome.incomplete.reason }; continue; }
    const r = compare(STRICT, ref, outcome.data);
    const status: OriginalStatus = prov.deterministic === false ? 'nondeterministic' : r.outcome === 'match' ? 'same' : r.outcome === 'difference' ? 'different' : 'couldnt_run';
    statuses[id] = { status, outcome: r.outcome, ...(status === 'different' || status === 'couldnt_run' ? { detail: r.outcome === 'difference' ? r.differences : r.diagnostics } : {}) };
  }
  const summary: Record<OriginalStatus, number> = { same: 0, different: 0, nondeterministic: 0, couldnt_run: 0, skipped: 0 };
  for (const s of Object.values(statuses)) summary[s.status]++;
  const ok = summary.different === 0 && summary.couldnt_run === 0;
  writeFileSync(o.out, JSON.stringify({ mode: 'original', image, binary: bin.name, summary, cases: statuses, ok }, null, 2) + '\n');
  console.log(JSON.stringify(summary), ok ? 'RECAPTURE OK: the original still produces the stored references' : 'RECAPTURE DIFFERS: see ' + o.out);
  return ok ? EXIT.ok : EXIT.mismatch;
}

