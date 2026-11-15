import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetLanguage } from '@lb/contracts';
import { targetCommand } from '../build/toolchains';
import { runCase, type RunOutcome } from './harness';

export interface CaseRun { argv: string[]; caseEnv: Record<string, string>; stdin: Buffer; files: { path: string; content: Buffer; mode: string }[]; timeoutMs: number }

export interface OriginalRunner {
  run(a: { artifactDir: string; binaryRel: string; hasLibs: boolean; case: CaseRun; workdir: string; imageDigest: string }): Promise<RunOutcome>;
}
export interface ReplacementRunner { run(a: { moduleDir: string; case: CaseRun; workdir: string; target?: TargetLanguage; imageDigest?: string }): Promise<RunOutcome> }

export const REPLACEMENT_CONTROLS = { TZ: 'UTC', LC_ALL: 'C.UTF-8', LB_FAKE_NOW: '2000-01-01T00:00:00.000Z', LB_SEED: '1' };

/** Runs the replacement shim with node on the host. UNSANDBOXED: dev/test only (requires DirectLauncher-style opt-in at wiring time). */
export class LocalReplacementRunner implements ReplacementRunner {
  async run(a: { moduleDir: string; case: CaseRun; workdir: string }) {
    return runCase({ command: process.execPath, args: [join(a.moduleDir, 'bin/cli.mjs'), ...a.case.argv], controlEnv: { ...REPLACEMENT_CONTROLS, PATH: process.env.PATH ?? '', HOME: a.workdir }, caseEnv: a.case.caseEnv, stdin: a.case.stdin, files: a.case.files, workdir: a.workdir, timeoutMs: a.case.timeoutMs });
  }
}

export interface DockerOpts { docker?: string; runtime?: string; platform?: string }

/**
 * The single source of truth for isolation flags (§8.1): no network, read-only rootfs, non-root, all capabilities dropped,
 * no-new-privileges, cgroup limits. `runtime: 'runsc'` selects gVisor on Linux worker hosts; Docker Desktop only has runc.
 */
export function hardeningArgs(o: { name: string; runtime?: string; platform?: string; build?: boolean }): string[] {
  return ['--name', o.name, ...(o.runtime ? [`--runtime=${o.runtime}`] : []), ...(o.platform ? ['--platform', o.platform] : []),
    '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    o.build ? '--memory=1g' : '--memory=512m', '--cpus=1', '--pids-limit=64', o.build ? '--tmpfs=/tmp:rw,size=512m' : '--tmpfs=/tmp:rw,size=64m'];
}

const imageByDigest = (image: string) => { if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('execution images must be pinned by digest'); return image; };

async function dockerRun(opts: DockerOpts, a: { image: string; mounts: string[]; env: Record<string, string>; cmd: string[]; platform?: string; workdir: string; c: CaseRun }): Promise<RunOutcome> {
  const docker = opts.docker ?? process.env.DOCKER_BIN ?? 'docker';
  mkdirSync(a.workdir, { recursive: true });
  chmodSync(a.workdir, 0o777); // the container runs as uid 10001
  const name = `lb-${Math.random().toString(36).slice(2, 10)}`;
  const args = ['run', '--rm', '-i', ...hardeningArgs({ name, runtime: opts.runtime, platform: a.platform }),
    ...a.mounts.flatMap((m) => ['-v', m]), '-v', `${a.workdir}:/work`, '-w', '/work',
    ...Object.entries(a.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), imageByDigest(a.image), ...a.cmd];
  const out = await runCase({ command: docker, args, controlEnv: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, caseEnv: {}, stdin: a.c.stdin, files: a.c.files, workdir: a.workdir, timeoutMs: a.c.timeoutMs });
  if (out.incomplete) execFile(docker, ['kill', name], () => {}); // the client was killed; make sure the container is too
  return out;
}

/** Runs the original ELF in a locked-down container. */
export class DockerOriginalRunner implements OriginalRunner {
  constructor(private opts: DockerOpts = {}) {}
  run(a: { artifactDir: string; binaryRel: string; hasLibs: boolean; case: CaseRun; workdir: string; imageDigest: string }) {
    const env = { TZ: 'UTC', LC_ALL: 'C.UTF-8', HOME: '/tmp', ...(a.hasLibs ? { LD_LIBRARY_PATH: '/opt/legacy/lib' } : {}), ...a.case.caseEnv };
    return dockerRun(this.opts, { image: a.imageDigest, mounts: [`${a.artifactDir}:/opt/legacy:ro`], env, cmd: [`/opt/legacy/${a.binaryRel}`, ...a.case.argv], platform: this.opts.platform ?? 'linux/amd64', workdir: a.workdir, c: a.case });
  }
}

/**
 * Runs the replacement shim in the same hardened container as the original (plan: lb-run-node22).
 * Customer/generated code may import any node: builtin, so it must never run in the worker's own process.
 */
export class DockerReplacementRunner implements ReplacementRunner {
  constructor(private image: string, private opts: DockerOpts = {}) {}
  run(a: { moduleDir: string; case: CaseRun; workdir: string; target?: TargetLanguage; imageDigest?: string }) {
    const env = { ...REPLACEMENT_CONTROLS, HOME: '/tmp', ...a.case.caseEnv };
    const target = a.target ?? 'typescript';
    const cmd = targetCommand(target).map(part => part.replace('{module}', '/opt/module'));
    return dockerRun(this.opts, { image: a.imageDigest ?? this.image, mounts: [`${a.moduleDir}:/opt/module:ro`], env,
      cmd: [...cmd, ...a.case.argv], platform: this.opts.platform ?? (target === 'typescript' ? undefined : 'linux/amd64'), workdir: a.workdir, c: a.case });
  }
}
