import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetLanguage } from '@lb/contracts';
import { hardeningArgs, type DockerOpts } from '../execution/runners';
import { writeTree, type JobControl } from '../runtime';
import type { BuildOutput } from './local';
import { buildScript, nativeToolchains, toolchainEnv } from './toolchains';

const outputLimit = 32 * 1024 * 1024;

function collect(dir: string) {
  const files: BuildOutput['files'] = [];
  let total = 0;
  function walk(path: string) {
    const item = join(dir, path);
    const stat = lstatSync(item);
    if (stat.isDirectory()) {
      for (const child of readdirSync(item).sort()) walk(path + '/' + child);
    } else {
      total += stat.size;
      if (!stat.isFile() || total > outputLimit || files.length >= 1024) throw new Error('invalid build output');
      files.push({ path, content: readFileSync(item) });
    }
  }
  walk('dist');
  if (!files.length) throw new Error('empty build output');
  return files;
}

/** Compiles only in Docker using trusted build files and an isolated, read-only source mount. */
export async function nativeBuild(target: Exclude<TargetLanguage, 'typescript'>, files: BuildOutput['files'], ctl: JobControl, opts: DockerOpts = {}): Promise<BuildOutput> {
  const toolchain = nativeToolchains[target];
  const docker = opts.docker ?? process.env.DOCKER_BIN ?? 'docker';
  const root = mkdtempSync(join(tmpdir(), 'lb-native-build-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  const name = 'lb-build-' + randomUUID();
  const controller = new AbortController();
  let interrupted: unknown;
  let pending: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = ctl.checkpoint().catch(error => { interrupted = error; controller.abort(); })
      .finally(() => { pending = undefined; });
  }, 5_000);
  try {
    mkdirSync(output);
    chmodSync(output, 0o777);
    const support = Object.entries({ ...toolchain.support, 'bin/build.sh': buildScript(target) })
      .map(([path, content]) => ({ path, content: Buffer.from(content) }));
    writeTree(input, [...files.filter(f => f.path.startsWith('src/')), ...support]);
    const args = ['run', '--rm', '--pull=never', ...hardeningArgs({ name, runtime: opts.runtime, platform: 'linux/amd64', build: true }),
      '-v', input + ':/input:ro', '-v', output + ':/out',
      ...Object.entries({ HOME: '/tmp', GOCACHE: '/tmp/go-cache', ...toolchainEnv }).flatMap(([k, v]) => ['-e', k + '=' + v]),
      '--entrypoint', '/bin/sh', toolchain.image, '-c', 'mkdir /tmp/project && cp -R /input/. /tmp/project && cd /tmp/project && sh bin/build.sh /out'];
    const outcome = await new Promise<{ status: BuildOutput['status']; log: string }>(resolve => {
      execFile(docker, args, { timeout: 180_000, maxBuffer: 512 * 1024, windowsHide: true, signal: controller.signal }, (error, stdout, stderr) => {
        const status = !error ? 'succeeded' : typeof error.code === 'number' && error.code !== 125 ? 'failed' : 'error';
        resolve({ status, log: (stdout + stderr).slice(0, 20_000) || (error ? String(error.code ?? 'build interrupted') : '') });
      });
    });
    clearInterval(heartbeat);
    await pending;
    if (interrupted) throw interrupted;
    const compiled = outcome.status === 'succeeded' ? collect(output) : [];
    return { ...outcome, diagnostics: outcome.status === 'succeeded' ? [] : [{ file: null, line: null, code: 'BUILD', message: outcome.log.slice(-1000) }],
      files: outcome.status === 'succeeded' ? [...compiled, ...support] : [], image: toolchain.image, toolchain: { target, platform: 'linux/amd64' } };
  } finally {
    clearInterval(heartbeat);
    await new Promise<void>(resolve => { execFile(docker, ['rm', '-f', name], { timeout: 5_000, windowsHide: true }, () => resolve()); });
    rmSync(root, { recursive: true, force: true });
  }
}
