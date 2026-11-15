/**
 * Exported harness replay modes (--docker, --original), pure parts and command construction only.
 * Docker is replaced by injected fakes: this proves the arguments and exit-code mapping, NOT that a container really runs
 * (the real --docker / --original runs are exercised separately against Docker runc).
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleHarness } from '../../workers/export/build';
import { RUN_CASES } from '../../workers/export/templates';
import { dockerBuildArgs, dockerFailure, dockerRunArgs, originalBinary, originalRunArgs, parseReplayArgs, replayInDocker, replayOriginal, EXIT, type Exec } from '../../workers/export/replay';
import { hardeningArgs } from '../../workers/execution/runners';
import type { RunOutcome, RunRequest } from '../../workers/execution/harness';

const root = join(__dirname, '../..');
const DIGEST = 'node:22-bookworm-slim@sha256:' + 'a'.repeat(64);
const ORIG = 'debian:bookworm-slim@sha256:' + 'b'.repeat(64);
const tmp = () => mkdtempSync(join(tmpdir(), 'lb-harness-test-'));
const put = (p: string, c: string | Buffer) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); };

describe('harness bundle', () => {
  it('stays one dependency-free ESM file and exposes the replay entry points', async () => {
    const text = (await bundleHarness(root)).toString();
    expect(text).not.toMatch(/from\s+["'](?!node:)[^"']+["']/); // only node: imports remain
    for (const name of ['parseReplayArgs', 'replayInDocker', 'replayOriginal', 'hardeningArgs']) expect(text).toContain(name);
    expect(RUN_CASES).toContain('--original');
  });
});

describe('parseReplayArgs', () => {
  it('defaults to host mode', () => expect(parseReplayArgs([])).toEqual({ mode: 'host', out: 'replay-report.json', docker: 'docker' }));
  it('parses flags and honors env for the docker binary', () => {
    expect(parseReplayArgs(['--docker', '--out', 'r.json'], { LB_DOCKER: '/x/docker' })).toEqual({ mode: 'docker', out: 'r.json', docker: '/x/docker' });
    expect(parseReplayArgs(['--original', '--docker-bin', 'd'])).toMatchObject({ mode: 'original', docker: 'd' });
  });
  it('rejects unknown flags, missing values and combining modes', () => {
    expect(parseReplayArgs(['--nope'])).toEqual({ error: 'unknown argument: --nope' });
    expect(parseReplayArgs(['--out'])).toMatchObject({ error: expect.stringContaining('needs a value') });
    expect(parseReplayArgs(['--out', '--docker'])).toMatchObject({ error: expect.stringContaining('needs a value') });
    expect(parseReplayArgs(['--docker', '--original'])).toMatchObject({ error: expect.stringContaining('cannot be combined') });
  });
});

describe('dockerFailure', () => {
  it('maps docker 125/126/127 distinctly and leaves program codes alone', () => {
    expect(dockerFailure(125)!.code).toBe(EXIT.dockerFailed);
    expect(dockerFailure(126)!.code).toBe(EXIT.notExecutable);
    expect(dockerFailure(127)!.code).toBe(EXIT.notFound);
    expect(new Set([125, 126, 127].map((c) => dockerFailure(c)!.message)).size).toBe(3);
    for (const c of [0, 1, 2, null]) expect(dockerFailure(c)).toBeNull();
  });
});

describe('--docker', () => {
  const pkg = (from = `FROM ${DIGEST}`) => { const d = tmp(); put(join(d, 'environment/Dockerfile.replacement'), `${from}\nCOPY . /pkg\n`); return d; };
  const recorder = (statuses: (number | null)[], errors: Record<number, Error> = {}) => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => { const i = calls.push([cmd, ...args]) - 1; return { status: statuses[i] ?? 0, signal: null, error: errors[i] } as any; };
    return { calls, exec };
  };
  const opts = (d: string) => ({ mode: 'docker' as const, out: join(d, 'r.json'), docker: 'docker' });

  it('builds the package image, then runs integrity + replay under the shared hardening', () => {
    const d = pkg(); const { calls, exec } = recorder([0, 0, 0]);
    expect(replayInDocker(d, opts(d), exec)).toBe(0);
    const [build, run, rmi] = calls;
    expect(build.slice(0, 2)).toEqual(['docker', 'build']);
    expect(build).toContain(join(d, 'environment/Dockerfile.replacement'));
    expect(build.at(-1)).toBe(d);
    const hard = hardeningArgs({ name: 'x' }).filter((a) => a !== 'x' && a !== '--name');
    for (const a of hard) expect(run).toContain(a);
    for (const f of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) expect(run).toContain(f);
    expect(run.join(' ')).toContain('node harness/verify-integrity.mjs && node harness/run-cases.mjs --out /out/replay-report.json');
    expect(rmi.slice(1, 3)).toEqual(['rmi', '-f']);
  });
  it('returns the replay result and copies the report out', () => {
    const d = pkg();
    const exec: Exec = (_c, args) => {
      if (args[0] === 'run') { const v = args[args.indexOf('-v', args.indexOf('-v')) + 1]; writeFileSync(join(v.split(':')[0], 'replay-report.json'), '{"ok":false}'); return { status: 1, signal: null } as any; }
      return { status: 0, signal: null } as any;
    };
    expect(replayInDocker(d, opts(d), exec)).toBe(1);
    expect(existsSync(join(d, 'r.json')) ? readFileSync(join(d, 'r.json'), 'utf8') : '').toBe('{"ok":false}');
  });
  it('reports docker failures with their own codes', () => {
    for (const [status, code] of [[125, 125], [126, 126], [127, 127]] as const) {
      const d = pkg(); expect(replayInDocker(d, opts(d), recorder([0, status, 0]).exec)).toBe(code);
    }
    const d = pkg(); expect(replayInDocker(d, opts(d), recorder([1]).exec)).toBe(EXIT.dockerFailed); // build failed
    const e = pkg(); expect(replayInDocker(e, opts(e), recorder([0], { 0: Object.assign(new Error('x'), { code: 'ENOENT' }) }).exec)).toBe(EXIT.notFound);
  });
  it('refuses an unpinned base image or a missing Dockerfile', () => {
    const d = pkg('FROM node:22'); const { calls, exec } = recorder([]);
    expect(replayInDocker(d, opts(d), exec)).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
    expect(replayInDocker(tmp(), opts(d), exec)).toBe(EXIT.usage);
  });
  it('builds the documented arguments', () => {
    expect(dockerBuildArgs('/p', 't')).toEqual(['build', '-t', 't', '-f', '/p/environment/Dockerfile.replacement', '/p']);
    expect(dockerRunArgs({ name: 'n', image: 'i', outDir: '/o' })).toEqual(expect.arrayContaining(['run', '--rm', '-v', '/o:/out', 'i', 'sh', '-c']));
  });
});

describe('--original', () => {
  function pkg(opts: { binary?: boolean; image?: string | null; cases?: Record<string, { ref?: { stdout: string; exit?: number }; deterministic?: boolean }> } = {}) {
    const d = tmp();
    if (opts.binary !== false) put(join(d, 'original/bin/tool'), '#!bin');
    put(join(d, 'MANIFEST.json'), JSON.stringify({ binding: { source_revision: { primary: { path: 'bin/tool' } } } }));
    put(join(d, 'environment/environment.json'), JSON.stringify({ original: opts.image === null ? [] : [{ image: opts.image ?? ORIG }] }));
    for (const [id, c] of Object.entries(opts.cases ?? {})) {
      put(join(d, `cases/${id}/input.json`), JSON.stringify({ name: id, argv: ['1', '2'], env: {}, timeout_ms: 1000, files: [] }));
      put(join(d, `cases/${id}/provenance.json`), JSON.stringify(c.ref ? { provenance: 'captured_original', deterministic: c.deterministic ?? true } : { provenance: null }));
      if (c.ref) {
        const empty = { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0, blob: null };
        put(join(d, `cases/${id}/reference/observation.json`), JSON.stringify({ exit: { code: c.ref.exit ?? 0, signal: null }, stdout: { ...empty, size: c.ref.stdout.length }, stderr: empty, files: [], truncated: { stdout: false, stderr: false, files: false }, complete: true }));
        put(join(d, `cases/${id}/reference/stdout.bin`), c.ref.stdout);
        put(join(d, `cases/${id}/reference/stderr.bin`), '');
      }
    }
    return d;
  }
  const outcome = (stdout: string, code = 0): RunOutcome => ({ data: { observation: { exit: { code, signal: null }, stdout: { sha256: 'x', size: stdout.length, blob: null }, stderr: { sha256: 'x', size: 0, blob: null }, files: [], truncated: { stdout: false, stderr: false, files: false }, complete: true } as any, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), files: {} } });
  const o = (d: string) => ({ mode: 'original' as const, out: join(d, 'r.json'), docker: 'docker' });

  it('exits 2 with a clear message when the package has no original binary', async () => {
    const d = pkg({ binary: false });
    expect('error' in originalBinary(d)).toBe(true);
    expect(await replayOriginal(d, o(d), { run: async () => { throw new Error('must not run'); } })).toBe(EXIT.usage);
  });
  it('requires a digest-pinned original image', async () => {
    for (const image of ['debian:bookworm-slim', null]) { const d = pkg({ image, cases: {} }); expect(await replayOriginal(d, o(d))).toBe(EXIT.usage); }
  });
  it('recaptures each case and reports same / different / nondeterministic / skipped without touching the package', async () => {
    const d = pkg({ cases: { a: { ref: { stdout: '0.67\n' } }, b: { ref: { stdout: '1.00\n' } }, c: { ref: { stdout: 'zzz' }, deterministic: false }, d: {} } });
    const requests: RunRequest[] = [];
    const run = async (r: RunRequest) => { requests.push(r); return outcome(requests.length === 1 ? '0.67\n' : '9.99\n'); };
    expect(await replayOriginal(d, o(d), { run, workdir: tmp })).toBe(EXIT.mismatch);
    const report = JSON.parse(readFileSync(o(d).out, 'utf8'));
    expect(report.cases).toMatchObject({ a: { status: 'same' }, b: { status: 'different' }, c: { status: 'nondeterministic' }, d: { status: 'skipped' } });
    expect(report.summary).toEqual({ same: 1, different: 1, nondeterministic: 1, couldnt_run: 0, skipped: 1 });
    expect(requests).toHaveLength(3); // the case without a reference never runs
    expect(requests[0].command).toBe('docker');
    for (const f of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) expect(requests[0].args).toContain(f);
    // The package copy is staged (zips drop the executable bit) and mounted read-only; the package itself is never mounted.
    const mount = requests[0].args.find((x) => x.endsWith(':/opt/legacy:ro'))!;
    expect(mount).toBeTruthy();
    expect(mount).not.toContain(join(d, 'original'));
    expect(requests[0].args).not.toContain(`${join(d, 'original')}:/opt/legacy:ro`);
    expect(requests[0].args).toContain('/opt/legacy/bin/tool');
    expect(requests[0].args.slice(-2)).toEqual(['1', '2']);
    expect(requests[0].args).toContain(ORIG);
    expect(existsSync(join(d, 'results'))).toBe(false); // never writes into results/
  });
  it('exits 0 when everything reproduces and reports an incomplete run as couldnt_run', async () => {
    const d = pkg({ cases: { a: { ref: { stdout: 'x' } } } });
    expect(await replayOriginal(d, o(d), { run: async () => outcome('x'), workdir: tmp })).toBe(EXIT.ok);
    const e = pkg({ cases: { a: { ref: { stdout: 'x' } } } });
    expect(await replayOriginal(e, o(e), { run: async () => ({ ...outcome('x'), incomplete: { reason: 'timeout' as const } }), workdir: tmp })).toBe(EXIT.mismatch);
    expect(JSON.parse(readFileSync(o(e).out, 'utf8')).cases.a.status).toBe('couldnt_run');
  });
  it('builds original runner arguments with the shared hardening, libs and case env', () => {
    const args = originalRunArgs({ name: 'n', image: ORIG, originalDir: '/p/original', workdir: '/w', binary: 'tool', hasLibs: true, caseEnv: { K: 'v' }, argv: ['a'] });
    expect(args).toEqual(expect.arrayContaining(['--platform', 'linux/amd64', '-e', 'LD_LIBRARY_PATH=/opt/legacy/lib', '-e', 'K=v', '-w', '/work']));
    expect(args.slice(-2)).toEqual(['/opt/legacy/bin/tool', 'a']);
  });
});
