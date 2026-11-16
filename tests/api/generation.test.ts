/**
 * S4 generation and source edits, driven through the API handlers and the worker with a FAKE provider (deterministic) and the real local `tsc` build.
 * Set LB_TEST_LIVE_CODEX=1 to also test the signed-in CLI with synthetic scope data. The tsc build is unsandboxed (dev/test).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import { uuidv7 } from '../../server/db/ids';
import { cancel } from '../../server/jobs/queue';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { generationWorkerCommand } from '../../server/api/codex-generation';
import { drain } from '../../workers/main';
import { generateHandler } from '../../workers/handlers/generate';
import { controlFor, writeTree, type WorkerEnv } from '../../workers/runtime';
import { localBuild } from '../../workers/build/local';
import { DockerReplacementRunner, LocalReplacementRunner } from '../../workers/execution/runners';
import { NODE_IMAGE } from '../../workers/export/build';
import { RemoteCodexGenerator } from '../../workers/generation/remote';
import { processRemoteGeneration } from '../../workers/generation/remote-client';
import { remoteGenerationPath, type RemoteGenerationJob } from '../../workers/generation/remote-contract';
import { unpackTar } from '../../server/tar';
import { RUN_CONTRACT, type CodeGenerator, type GenerationRequest, type GenerationResult } from '../../workers/generation/provider';
import type { Db } from '../../server/db/db';

process.env.LB_DEV_AUTH = '1';
const root = join(__dirname, '../..');
const org = uuidv7(), other = uuidv7(), editor = uuidv7(), otherUser = uuidv7(), pid = uuidv7(), src = uuidv7();
let db: Db, env: WorkerEnv;
const requests: GenerationRequest[] = [];
let next: () => GenerationResult;
const fake: CodeGenerator = {
  describe: () => ({ provider: 'fake', model: 'fake-1' }),
  async generate(req) { requests.push(structuredClone(req)); return next(); },
};
const GOOD = `/* LB-BEHAVIOR:count */
export async function run(input: { argv: string[]; stdin: Uint8Array }, deps: { cwd: string }): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  if (input.argv.length) return { stderr: 'usage: wc\\n', exitCode: 2 };
  void deps;
  return { stdout: String(Buffer.from(input.stdin).toString('utf8').split(/\\s+/).filter(Boolean).length) + '\\n' };
}
/* LB-UNTRANSLATED:overflow */
`;
const result = (over: Partial<GenerationResult> = {}): GenerationResult => ({
  files: [{ path: 'src/index.ts', content: GOOD }], untranslated: [{ id: 'overflow', behaviorId: 'count', file: 'src/index.ts', line: 3, reason: 'Original wraps at 2^31; not reproduced', evidence: [] }],
  notes: 'ok', usage: { inputTokens: 10, outputTokens: 20 }, transcript: { fake: true }, modelVersion: 'fake-1.0', ...over,
});

async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, path: string, o: { who?: { org: string; user: string }; body?: unknown; params?: Record<string, string> } = {}) {
  const who = o.who ?? { org, user: editor };
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-org-id': who.org, 'x-user-id': who.user };
  if (method === 'POST') headers['idempotency-key'] = uuidv7();
  const res = await h(new Request(`http://t${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const heads = async () => (await db.query<{ approved_scope_revision_id: string; current_module_revision_id: string }>('SELECT approved_scope_revision_id, current_module_revision_id FROM projects WHERE id=$1', [pid]))[0];
const generate = (body: Record<string, unknown> = {}) => call(api.moduleCreate, 'POST', '/m', { params: { pid }, body: { origin: 'generated', scope_revision_id: scopeId, ...body } });
const modules = () => db.query<{ id: string; number: number; origin: string; parent_id: string | null; generator: Record<string, any> | null; untranslated: unknown[] }>('SELECT id, number, origin, parent_id, generator, untranslated FROM module_revisions WHERE project_id=$1 ORDER BY number', [pid]);
const lastJob = async () => (await db.query<{ status: string; error: { code: string } | null }>("SELECT status, error FROM jobs WHERE kind='generate' ORDER BY created_at DESC, id DESC LIMIT 1"))[0];
function remoteWorkerKeys() {
  const workerKey = uuidv7();
  const demoKey = uuidv7();
  vi.stubEnv('LB_CODEX_ORG_ID', org);
  vi.stubEnv('LB_CODEX_WORKER_KEY', workerKey);
  vi.stubEnv('LB_CODEX_DEMO_KEY', demoKey);
  return { workerKey, demoKey };
}
let scopeId: string, findingId: string;

beforeAll(async () => {
  db = await testDb();
  const store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'gen-blobs-')));
  setApp({ db, store });
  for (const o of [org, other]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  for (const [o, u] of [[org, editor], [other, otherUser]]) {
    await db.query('INSERT INTO users(id,email) VALUES ($1,$2)', [u, `${u}@x`]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [o, u]);
  }
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [pid, org]);
  await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [org, 'd'.repeat(64)]);
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, org, pid]);
  await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/tool','primary_executable',$3,1)", [src, org, 'd'.repeat(64)]);
  await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [pid, src]);
  const run = uuidv7();
  await db.query("INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,kind,provider,params_digest,outcome) VALUES ($1,$2,$3,$4,'index','rea-ghidra','d','complete')", [run, org, pid, src]);
  findingId = uuidv7();
  await db.query(`INSERT INTO findings(id,org_id,source_revision_id,analysis_run_id,kind,stable_key,name,address,authority,attributes,location,artifact_path,artifact_sha256,provider_evidence_id)
    VALUES ($1,$2,$3,$4,'function','fn:1','count_words','0x401000','tool_inferred','{"size":120}','{}','bin/tool',$5,$6)`, [findingId, org, src, run, 'd'.repeat(64), 'ev_' + 'a'.repeat(64)]);
  env = { db, store, workRoot: mkdtempSync(join(tmpdir(), 'gen-work-')), workerId: 'w-gen', original: { run: async () => { throw new Error('no'); } }, replacement: new LocalReplacementRunner(), build: (f) => localBuild(f, { repoRoot: root }), generator: fake };
});

describe('S4 generation', () => {
  it('a module that follows the run() contract works through the real CLI shim', async () => {
    const built = await localBuild([{ path: 'src/index.ts', content: Buffer.from(GOOD) }], { repoRoot: root });
    expect(built.status).toBe('succeeded');
    const moduleDir = mkdtempSync(join(tmpdir(), 'gen-mod-'));
    writeTree(moduleDir, built.files);
    const out = await new LocalReplacementRunner().run({ moduleDir, workdir: mkdtempSync(join(tmpdir(), 'gen-run-')), case: { argv: [], caseEnv: {}, stdin: Buffer.from('one two  three\n'), files: [], timeoutMs: 20_000 } });
    expect(out.incomplete).toBeUndefined();
    expect(out.data.observation.exit).toMatchObject({ code: 0 });
    expect(out.data.stdout.toString()).toBe('3\n');
    const bad = await new LocalReplacementRunner().run({ moduleDir, workdir: mkdtempSync(join(tmpdir(), 'gen-run-')), case: { argv: ['--x'], caseEnv: {}, stdin: Buffer.alloc(0), files: [], timeoutMs: 20_000 } });
    expect(bad.data.observation.exit).toMatchObject({ code: 2 });
  });

  it('needs an approved current scope and an org that allows an external model', async () => {
    const res = await api.scopeDraftPut(new Request('http://t/d', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': editor, 'if-match': '"v0"' }, body: JSON.stringify({ document: { workflow: { name: 'wc', invocation: { argv_template: [], stdin: 'text' } }, interface: { language: 'typescript' }, behaviors: [{ id: 'count', statement: 'Counts words', basis: 'inferred', evidence: [findingId] }, { id: 'other', statement: 'Prints a total', basis: 'observed' }] } }) }), { params: Promise.resolve({ pid }) });
    expect(res.status).toBe(200);
    const rev = (await call(api.scopeRevisionCreate, 'POST', '/r', { params: { pid }, body: { from_draft_version: 1 } })).json;
    scopeId = rev.id;
    expect((await generate()).json.code).toBe('scope_not_approved');
    expect((await call(api.scopeDecision, 'POST', '/x', { params: { rid: scopeId }, body: { decision: 'approved', document_sha256: rev.document_sha256 } })).status).toBe(200);
    const denied = await generate();
    expect(denied).toMatchObject({ status: 409, json: { code: 'external_model_not_allowed' } });
    expect(await db.query("SELECT 1 FROM jobs WHERE kind='generate'")).toHaveLength(0);
    await db.query('UPDATE organizations SET external_model_allowed=true WHERE id=$1', [org]);
    expect((await generate({ scope_revision_id: uuidv7() })).status).toBe(409);
    expect((await call(api.moduleCreate, 'POST', '/m', { who: { org: other, user: otherUser }, params: { pid }, body: { origin: 'generated', scope_revision_id: scopeId } })).status).toBe(404);
  });

  it('rejects invalid model output and creates no revision', async () => {
    const bad: [string, GenerationResult][] = [
      ['unsafe suggested input', result({ testCases: [{ name: 'unsafe', argv: [], stdin: '', files: [{ path: '../escape', text: 'x' }] }] })],
      ['traversal', result({ files: [{ path: 'src/../../etc/x.ts', content: 'x' }] })],
      ['outside src and test', result({ files: [{ path: 'src/index.ts', content: GOOD }, { path: 'package.json', content: '{}' }] })],
      ['third-party import', result({ files: [{ path: 'src/index.ts', content: "import _ from 'lodash';\n" + GOOD }] })],
      ['dynamic import', result({ files: [{ path: 'src/index.ts', content: "const m = await import('left-pad');\n" + GOOD }] })],
      ['no entry', result({ files: [{ path: 'src/other.ts', content: GOOD }] })],
      ['unknown behavior in untranslated', result({ untranslated: [{ id: 'u', behaviorId: 'nope', file: '', line: 0, reason: 'x', evidence: [] }] })],
      ['untranslated without reason', result({ untranslated: [{ id: 'u', file: '', line: 0, reason: ' ', evidence: [] }] })],
    ];
    for (const [name, r] of bad) {
      next = () => r;
      expect((await generate()).status, name).toBe(202);
      await drain(env, ['generate']);
      expect(await lastJob(), name).toMatchObject({ status: 'failed', error: { code: 'generation_output_invalid' } });
      expect(await modules(), name).toHaveLength(0);
    }
  });

  it('records provider, model, digests and transcript, passes cited evidence, and builds with marker warnings', async () => {
    requests.length = 0;
    next = () => result({ testCases: [{ name: 'Three words', argv: [], stdin: 'one two three', files: [{ path: 'example.txt', text: 'sample' }] }] });
    expect((await generate()).status).toBe(202);
    await drain(env, ['generate']);
    const [m] = await modules();
    expect(m).toMatchObject({ number: 1, origin: 'generated', parent_id: null });
    expect(m.generator).toMatchObject({ provider: 'fake', model: 'fake-1', model_version: 'fake-1.0', template_version: 'ts-cli-v1', input_digest: expect.stringMatching(/^[0-9a-f]{64}$/), output_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await db.query('SELECT 1 FROM blobs WHERE org_id=$1 AND sha256=$2', [org, m.generator!.transcript_blob])).length).toBe(1);
    expect(m.untranslated).toMatchObject([{ id: 'overflow', behaviorId: 'count' }]);
    expect(requests[0].evidence).toMatchObject([{ findingId, kind: 'function', name: 'count_words', artifactSha256: 'd'.repeat(64) }]);
    expect(requests[0].scope.id).toBe(scopeId);
    expect(requests[0].target.runContract).toBe(RUN_CONTRACT);
    expect(RUN_CONTRACT).toContain('stdin: Uint8Array'); // the shape the CLI shim passes
    expect((await heads()).current_module_revision_id).toBe(m.id);

    await drain(env, ['build']);
    const mod = (await call(api.moduleGet, 'GET', '/m', { params: { mid: m.id } })).json;
    expect(mod.build.status).toBe('succeeded');
    // behavior "other" has no marker and is not listed: reported, but the build still succeeds.
    expect(mod.build.diagnostics).toEqual([expect.objectContaining({ code: 'LB_UNADDRESSED_BEHAVIOR', severity: 'warning', message: expect.stringContaining('other') })]);
  });

  it('loads suggested inputs once, downloads portable cases and packages the built replacement', async () => {
    const first = await call(api.testCasePrepare, 'POST', '/tests', { params: { pid } });
    expect(first).toMatchObject({ status: 200, json: { count: 1, basic: false } });
    expect((await call(api.testCasePrepare, 'POST', '/tests', { params: { pid } })).json.count).toBe(1);
    const cases = await call(api.testCaseDownload, 'GET', '/tests', { params: { pid } });
    expect(cases.json).toHaveLength(1);
    expect(cases.json[0]).toMatchObject({ name: 'Three words', input: { stdin: { base64: Buffer.from('one two three').toString('base64') }, files: [{ path: 'example.txt', base64: Buffer.from('sample').toString('base64') }] } });
    expect(await db.query('SELECT 1 FROM reference_outputs WHERE org_id=$1', [org])).toHaveLength(0);
    const [mod] = await modules();
    const preview = await call(api.modulePackage, 'GET', '/package?preview=1', { params: { mid: mod.id } });
    expect(preview.json.functions).toContainEqual({ name: 'run', path: 'src/index.ts' });
    const response = await api.modulePackage(new Request('http://t/package', { headers: { 'x-org-id': org, 'x-user-id': editor } }), { params: Promise.resolve({ mid: mod.id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const archive = Buffer.from(await response.arrayBuffer());
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    for (const path of ['src/index.ts', 'dist/index.js', 'bin/cli.mjs', 'package.json', 'tsconfig.json']) expect(archive.includes(Buffer.from(path)), path).toBe(true);
    const who = { org: other, user: otherUser };
    expect((await call(api.testCasePrepare, 'POST', '/tests', { params: { pid }, who })).status).toBe(404);
    expect((await call(api.testCaseDownload, 'GET', '/tests', { params: { pid }, who })).status).toBe(404);
    expect((await call(api.modulePackage, 'GET', '/package', { params: { mid: mod.id }, who })).status).toBe(404);
  });

  it('a retried job does not create a second revision', async () => {
    const job = (await db.query<any>("SELECT * FROM jobs WHERE kind='generate' AND status='succeeded' ORDER BY created_at DESC LIMIT 1"))[0];
    await generateHandler(env, { ...job, payload: job.payload }, controlFor(env, job));
    expect(await modules()).toHaveLength(1);
  });

  it('repair is a new request from persisted state: prior files and build diagnostics, as revision N+1', async () => {
    const [m1] = await modules();
    requests.length = 0;
    next = () => result({ files: [{ path: 'src/index.ts', content: GOOD + '// fixed\n' }], untranslated: [] });
    expect((await generate({ parent_id: m1.id, instructions: 'handle empty input', unknown_questions: ['overflow'], sample_input: { name: 'example.txt', text: 'a b c' } })).status).toBe(202);
    await drain(env, ['generate']);
    expect(requests[0].priorRevision).toMatchObject({ id: m1.id, files: [{ path: 'src/index.ts' }], buildDiagnostics: [{ code: 'LB_UNADDRESSED_BEHAVIOR' }] });
    expect(requests[0].instructions).toBe('handle empty input');
    expect(requests[0].sampleInput).toEqual({ name: 'example.txt', text: 'a b c' });
    const all = await modules();
    expect(all.map((x) => [x.number, x.parent_id])).toEqual([[1, null], [2, m1.id]]);
    expect(all[1].untranslated).toMatchObject([{ id: 'overflow' }]);
  });

  it('a user edit creates revision N+1, inherits the untranslated list and builds automatically', async () => {
    const [, m2] = await modules();
    const edit = await call(api.moduleCreate, 'POST', '/m', { params: { pid }, body: { origin: 'user_edit', scope_revision_id: scopeId, parent_id: m2.id, changes: [{ path: 'src/index.ts', content: GOOD + '// edited by a person\n' }] } });
    expect(edit).toMatchObject({ status: 201, json: { number: 3, build: { status: 'building' }, is_current: true } });
    expect((await modules())[2]).toMatchObject({ origin: 'user_edit', parent_id: m2.id, untranslated: [{ id: 'overflow' }] });
    await drain(env, ['build']);
    expect((await call(api.moduleGet, 'GET', '/m', { params: { mid: edit.json.id } })).json.build.status).toBe('succeeded');
  });

  it('aborts in-flight generation and publishes no revision after cancellation', async () => {
    const count = (await modules()).length;
    const queued = await generate({ instructions: 'cancel fixture' });
    expect(queued.status).toBe(202);
    const generator: CodeGenerator = {
      ...fake,
      async generate(_req, { signal }) {
        const interruption = new Promise<GenerationResult>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        expect(await cancel(db, org, queued.json.job_id)).toBe('cancel_requested');
        return interruption;
      },
    };
    await drain({ ...env, generator }, ['generate']);
    expect(await lastJob()).toMatchObject({ status: 'cancelled' });
    expect(await modules()).toHaveLength(count);
  });

  it('does not publish when organization consent is revoked during generation', async () => {
    const count = (await modules()).length;
    const generator: CodeGenerator = {
      ...fake,
      async generate() {
        await db.query('UPDATE organizations SET external_model_allowed=false WHERE id=$1', [org]);
        return result();
      },
    };
    expect((await generate()).status).toBe(202);
    try {
      await drain({ ...env, generator }, ['generate']);
      expect(await lastJob()).toMatchObject({ status: 'failed', error: { code: 'external_model_not_allowed' } });
      expect(await modules()).toHaveLength(count);
    } finally {
      await db.query('UPDATE organizations SET external_model_allowed=true WHERE id=$1', [org]);
    }
  });

  it.each([false, true])('routes requests and rejects unauthorized or stale remote leases (cancelled=%s)', async (cancelled) => {
    const { workerKey, demoKey } = remoteWorkerKeys();
    const send = (body: object, token = workerKey) => generationWorkerCommand(new Request('https://example.test' + remoteGenerationPath, {
      method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body),
    }));
    const generator = new RemoteCodexGenerator({ db, store: env.store, orgId: org, model: 'fixture-model' });
    const count = (await modules()).length;
    const { json, status } = await generate();
    expect(status).toBe(202);
    const running = drain({ ...env, generator }, ['generate']);
    try {
      expect((await send({ action: 'claim' }, demoKey)).status).toBe(401);
      let remote: RemoteGenerationJob | null = null;
      for (let i = 0; !remote && i < 40; i++) {
        const claimed = await send({ action: 'claim' });
        expect(claimed.status).toBe(200);
        remote = await claimed.json() as RemoteGenerationJob | null;
        if (!remote) await sleep(100);
      }
      expect(remote).toMatchObject({ model: 'fixture-model', request: { scope: { id: scopeId }, evidence: [{ findingId }] } });
      const { id, lease } = remote!;
      expect((await send({ action: 'heartbeat', id, lease: uuidv7() })).status).toBe(409);
      if (cancelled) {
        expect(await cancel(db, org, json.job_id)).toBe('cancel_requested');
        expect(await (await send({ action: 'heartbeat', id, lease })).json()).toEqual({ cancelRequested: true });
        const { files, untranslated, notes, usage } = result();
        expect((await send({ action: 'complete', id, lease, result: { files, untranslated, notes, usage } })).status).toBe(409);
      } else {
        await processRemoteGeneration(remote!, { ...fake, generate: async () => result() },
          body => send(body), new AbortController().signal);
      }
      await running;
      expect(await lastJob()).toMatchObject({ status: cancelled ? 'cancelled' : 'succeeded' });
      const rows = await modules();
      expect(rows).toHaveLength(count + (cancelled ? 0 : 1));
      if (!cancelled) expect(rows.at(-1)?.generator).toMatchObject({ provider: 'codex', model: 'fixture-model' });
    } finally {
      await cancel(db, org, json.job_id);
      await running;
      vi.unstubAllEnvs();
    }
  });

  it('the API cannot create a generated revision without the worker, and the worker only claims generate when a provider is configured', async () => {
    const { createModuleRevision } = await import('../../server/domain/modules');
    await expect(createModuleRevision({ db, store: env.store, orgId: org, userId: editor }, pid, { origin: 'generated', scope_revision_id: scopeId, files: [{ path: 'src/index.ts', content: GOOD }] })).rejects.toMatchObject({ status: 422 });
    expect((await generate({ instructions: 'again' })).status).toBe(202);
    expect(await drain({ ...env, generator: undefined }, ['generate'])).toBe(0);
    expect((await db.query("SELECT status FROM jobs WHERE kind='generate' ORDER BY created_at DESC LIMIT 1"))[0]).toMatchObject({ status: 'queued' });
  });

  it('re-approval of the scope blocks generation from the old revision', async () => {
    await db.query("UPDATE jobs SET status='cancelled' WHERE kind='generate' AND status='queued'");
    const put = await api.scopeDraftPut(new Request('http://t/d', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': editor, 'if-match': '"v1"' }, body: JSON.stringify({ document: { workflow: { name: 'wc2', invocation: { argv_template: [] } }, interface: { language: 'typescript' }, behaviors: [{ id: 'count', statement: 'Counts words', basis: 'observed' }] } }) }), { params: Promise.resolve({ pid }) });
    expect(put.status).toBe(200);
    const rev = (await call(api.scopeRevisionCreate, 'POST', '/r', { params: { pid }, body: { from_draft_version: 2 } })).json;
    await call(api.scopeDecision, 'POST', '/x', { params: { rid: rev.id }, body: { decision: 'approved', document_sha256: rev.document_sha256 } });
    expect((await generate()).json.code).toBe('scope_not_current');
  });

  it.skipIf(process.env.LB_TEST_LIVE_CODEX !== '1')('generates, builds, and runs a synthetic module with Codex', async () => {
    const put = await api.scopeDraftPut(new Request('http://t/d', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': editor, 'if-match': '"v2"' },
      body: JSON.stringify({ document: {
        workflow: { name: 'Word counter', invocation: { argv_template: [], stdin: 'text' } },
        interface: { language: 'typescript' },
        behaviors: [{ id: 'count', statement: 'Read UTF-8 stdin. Count nonempty tokens separated by whitespace. Write the decimal count followed by one newline to stdout. Empty input writes 0 and one newline.', basis: 'observed' }],
      } }),
    }), { params: Promise.resolve({ pid }) });
    expect(put.status).toBe(200);
    const rev = (await call(api.scopeRevisionCreate, 'POST', '/r', { params: { pid }, body: { from_draft_version: 3 } })).json;
    expect((await call(api.scopeDecision, 'POST', '/x', { params: { rid: rev.id }, body: { decision: 'approved', document_sha256: rev.document_sha256 } })).status).toBe(200);
    expect((await generate({ scope_revision_id: rev.id })).status).toBe(202);
    const { workerKey } = remoteWorkerKeys();
    const server = createServer(async (incoming, outgoing) => {
      try {
        const data: Buffer[] = [];
        for await (const chunk of incoming) data.push(chunk as Buffer);
        if (incoming.url !== remoteGenerationPath) { outgoing.writeHead(404).end(); return; }
        const response = await generationWorkerCommand(new Request('http://127.0.0.1' + incoming.url, {
          method: 'POST', headers: { authorization: incoming.headers.authorization ?? '' }, body: new Uint8Array(Buffer.concat(data)),
        }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
      } catch { outgoing.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing smoke test server address');
    const worker = spawn(process.execPath, ['--import', 'tsx', 'workers/codex-worker.ts'], {
      cwd: root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, LB_REA_ENTRY: '', LB_CODEX_WORKER_KEY: workerKey, LB_SITE_URL: `http://127.0.0.1:${address.port}` },
    });
    const generator = new RemoteCodexGenerator({ db, store: env.store, orgId: org, model: process.env.LB_GENERATION_MODEL });
    try { await drain({ ...env, generator }, ['generate']); }
    finally {
      worker.kill();
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => resolve()); });
      vi.unstubAllEnvs();
    }
    expect(await lastJob()).toMatchObject({ status: 'succeeded' });
    const m = (await modules()).at(-1)!;
    expect(m.generator).toMatchObject({ ...generator.describe(), usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) } });
    await drain(env, ['build']);
    expect((await call(api.moduleGet, 'GET', '/m', { params: { mid: m.id } })).json.build.status).toBe('succeeded');
    const [built] = await db.query<{ output_blob_sha256: string }>(
      'SELECT output_blob_sha256 FROM build_results WHERE org_id=$1 AND module_revision_id=$2', [org, m.id],
    );
    const moduleDir = mkdtempSync(join(tmpdir(), 'gen-live-module-'));
    writeTree(moduleDir, unpackTar(await env.store.get(org, built.output_blob_sha256)));
    const runner = new DockerReplacementRunner(NODE_IMAGE);
    for (const [stdin, stdout] of [['one\t two\nthree ', '3\n'], ['', '0\n']]) {
      const out = await runner.run({ moduleDir, workdir: mkdtempSync(join(tmpdir(), 'gen-live-run-')),
        case: { argv: [], caseEnv: {}, stdin: Buffer.from(stdin), files: [], timeoutMs: 20_000 } });
      expect(out.incomplete).toBeUndefined();
      expect(out.data.observation.exit).toMatchObject({ code: 0 });
      expect(out.data.stdout.toString()).toBe(stdout);
    }
  }, 11 * 60_000);
});
