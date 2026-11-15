import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCase, type RunRequest } from '../../workers/execution/harness';

const dir = () => mkdtempSync(join(tmpdir(), 'lb-'));
const node = (code: string, o: Partial<RunRequest> = {}): RunRequest => ({
  command: process.execPath, args: ['-e', code], controlEnv: { TZ: 'UTC' }, caseEnv: {}, stdin: Buffer.alloc(0), files: [], workdir: dir(), timeoutMs: 5000, ...o,
});

describe('harness', () => {
  it('captures exit, separate streams, byte-exact stdin', async () => {
    const r = await runCase(node("process.stdin.pipe(process.stdout); process.stderr.write('e'); process.exitCode=3", { stdin: Buffer.from([0, 255, 10, 13]) }));
    expect(r.incomplete).toBeUndefined();
    expect(r.data.stdout).toEqual(Buffer.from([0, 255, 10, 13]));
    expect(r.data.stderr.toString()).toBe('e');
    expect(r.data.observation.exit).toEqual({ code: 3, signal: null });
  });
  it('uses a clean env: host variables are not inherited', async () => {
    process.env.LB_SECRET = 'leak';
    const r = await runCase(node('console.log(JSON.stringify(process.env))', { caseEnv: { A: '1' } }));
    expect(JSON.parse(r.data.stdout.toString())).toMatchObject({ TZ: 'UTC', A: '1' });
    expect(r.data.stdout.toString()).not.toContain('leak');
  });
  it.skipIf(process.platform === 'win32')('a POSIX signal death is an observation (complete)', async () => {
    const r = await runCase(node("process.kill(process.pid,'SIGSEGV')"));
    expect(r.data.observation.complete).toBe(true);
    expect(r.data.observation.exit.signal).toBe('SIGSEGV');
  });
  it('timeout and output cap are incomplete (couldnt_run material)', async () => {
    const t = await runCase(node('setInterval(()=>{},1000)', { timeoutMs: 300 }));
    expect(t.incomplete?.reason).toBe('timeout');
    expect(t.data.observation.complete).toBe(false);
    const o = await runCase(node("process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)", { outputCap: 1000 }));
    expect(o.incomplete?.reason).toBe('output_cap');
    expect(o.data.observation.truncated.stdout).toBe(true);
    expect(o.data.stdout.length).toBe(1000);
  });
  it('observes created/modified/deleted files; unchanged inputs are not reported', async () => {
    const r = await runCase(node("const fs=require('fs');fs.mkdirSync('out');fs.writeFileSync('out/r.csv','1,2');fs.appendFileSync('db.txt','b');fs.unlinkSync('gone.txt')", {
      files: [{ path: 'db.txt', content: Buffer.from('a'), mode: '0644' }, { path: 'gone.txt', content: Buffer.from('x'), mode: '0644' }, { path: 'same.txt', content: Buffer.from('s'), mode: '0644' }],
    }));
    const f = Object.fromEntries(r.data.observation.files.map((x) => [x.path, x.status]));
    expect(f).toEqual({ 'out/r.csv': 'created', 'db.txt': 'modified', 'gone.txt': 'deleted' });
    expect(r.data.files['out/r.csv'].toString()).toBe('1,2');
  });
  it('rejects case files that escape the workdir', async () => {
    await expect(runCase(node('', { files: [{ path: '../evil', content: Buffer.from('x'), mode: '0644' }] }))).rejects.toThrow(/escapes/);
    await expect(runCase(node('', { files: [{ path: '/etc/evil', content: Buffer.from('x'), mode: '0644' }] }))).rejects.toThrow(/escapes/);
  });
  it('spawn failure is incomplete', async () => {
    const r = await runCase({ ...node(''), command: '/nonexistent/bin' });
    expect(r.incomplete?.reason).toBe('spawn_error');
  });
});
