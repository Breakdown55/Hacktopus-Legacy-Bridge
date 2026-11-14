/**
 * Hostile-module containment. A module is allowed to `import 'node:*'`, so the sandbox, not the import filter, is the boundary.
 * Runs a module that tries the host-takeover moves inside DockerReplacementRunner and asserts each one fails.
 * Docker Desktop = runc (not gVisor): this proves the container flags, not the gVisor tier. Skips without Docker.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localBuild } from '../../workers/build/local';
import { DockerReplacementRunner } from '../../workers/execution/runners';
import { NODE_IMAGE } from '../../workers/export/build';
import { writeTree } from '../../workers/runtime';

const docker = [process.env.DOCKER_BIN, `${process.env.HOME}/.docker/bin/docker`, '/usr/local/bin/docker'].filter(Boolean).find((d) => { try { execFileSync(d!, ['info'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } });
if (!docker) console.warn('[sandbox] SKIPPED: docker unavailable');
if (docker) process.env.PATH = `${docker.replace(/\/docker$/, '')}:${process.env.PATH}`;

const HOSTILE = `
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
const tryIt = async (name: string, f: () => unknown | Promise<unknown>) => { try { await f(); return name + ': ALLOWED'; } catch (e) { return name + ': blocked'; } };
export async function run() {
  const out = [
    await tryIt('write-module-dir', () => writeFileSync('/opt/module/pwned', 'x')),
    await tryIt('write-rootfs', () => writeFileSync('/etc/pwned', 'x')),
    await tryIt('docker-socket', () => { if (!existsSync('/var/run/docker.sock')) throw new Error('no socket'); }),
    await tryIt('spawn-docker', () => execFileSync('docker', ['ps'])),
    await tryIt('network', () => new Promise((res, rej) => { const r = request('http://example.com', (x) => res(x)); r.on('error', rej); r.setTimeout(3000, () => rej(new Error('timeout'))); r.end(); })),
    'uid: ' + process.getuid!(),
    'host-home-visible: ' + existsSync('/Users'),
  ];
  return { stdout: out.join('\\n') + '\\n' };
}
`;

describe.skipIf(!docker)('hostile replacement module', () => {
  it('cannot write outside /work, reach docker, use the network, or run as root', async () => {
    const built = await localBuild([{ path: 'src/index.ts', content: Buffer.from(HOSTILE) }], { repoRoot: join(__dirname, '../..') });
    expect(built.status, JSON.stringify(built.diagnostics)).toBe('succeeded');
    const moduleDir = mkdtempSync(join(tmpdir(), 'hostile-module-'));
    writeTree(moduleDir, built.files);
    const r = await new DockerReplacementRunner(NODE_IMAGE).run({ moduleDir, workdir: mkdtempSync(join(tmpdir(), 'hostile-work-')), case: { argv: [], caseEnv: {}, stdin: Buffer.alloc(0), files: [], timeoutMs: 30_000 } });
    expect(r.incomplete).toBeUndefined();
    const out = r.data.stdout.toString();
    expect(out).toContain('write-module-dir: blocked');
    expect(out).toContain('write-rootfs: blocked');
    expect(out).toContain('docker-socket: blocked');
    expect(out).toContain('spawn-docker: blocked');
    expect(out).toContain('network: blocked');
    expect(out).toContain('uid: 10001');
    expect(out).toContain('host-home-visible: false');
    expect(out).not.toContain('ALLOWED');
  }, 90_000);
});
