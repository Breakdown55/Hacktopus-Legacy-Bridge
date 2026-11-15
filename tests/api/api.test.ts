import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testDb } from '../helpers/testdb';
import { buildElf } from '../helpers/elf';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { drain } from '../../workers/main';
import { LocalReplacementRunner, type OriginalRunner } from '../../workers/execution/runners';
import { localBuild } from '../../workers/build/local';
import { ensureEnvironment, CONTROLS } from '../../server/domain/environments';
import type { WorkerEnv } from '../../workers/runtime';
import type { Db } from '../../server/db/db';

process.env.LB_DEV_AUTH = '1';
const root = join(__dirname, '../..');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = { org: uuidv7(), editor: uuidv7(), viewer: uuidv7(), admin: uuidv7() };
const B = { org: uuidv7(), editor: uuidv7() };
let db: Db, store: FsBlobStore, env: WorkerEnv;
const ids: Record<string, string> = {};

type Who = { org: string; user: string } | null;
async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, path: string, o: { who?: Who; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; idem?: string | false } = {}) {
  const who = o.who === undefined ? { org: A.org, user: A.editor } : o.who;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(who ? { 'x-org-id': who.org, 'x-user-id': who.user } : {}), ...o.headers };
  if (method === 'POST' && o.idem !== false) headers['idempotency-key'] = o.idem ?? uuidv7();
  const res = await h(new Request(`http://t${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}
const ok = async (p: ReturnType<typeof call>, status = 200) => { const r = await p; expect(r.status, JSON.stringify(r.json)).toBe(status); return r.json; };

beforeAll(async () => {
  db = await testDb();
  store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'api-blobs-')));
  setApp({ db, store });
  for (const o of [A.org, B.org]) await db.query("INSERT INTO organizations(id,name,execution_enabled) VALUES ($1,'o',false)", [o]);
  for (const [o, u, r] of [[A.org, A.editor, 'editor'], [A.org, A.viewer, 'viewer'], [A.org, A.admin, 'admin'], [B.org, B.editor, 'admin']]) {
    await db.query("INSERT INTO users(id,email) VALUES ($1,$2)", [u, `${u}@x`]);
    await db.query('INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,$3)', [o, u, r]);
  }
  const fakeOriginal: OriginalRunner = { run: async () => { throw new Error('original must not run in API tests'); } };
  env = { db, store, workRoot: mkdtempSync(join(tmpdir(), 'api-work-')), workerId: 'w-api', original: fakeOriginal, replacement: new LocalReplacementRunner(), build: (f) => localBuild(f, { repoRoot: root }) };
  ids.replEnv = await ensureEnvironment(db, { name: 'replacement-node-local', version: 1, role: 'replacement', image_digest: `local-node@${process.version}`, arch: process.arch, controls: CONTROLS });
});

describe('auth, roles, errors', () => {
  it('no headers -> 401; non-member -> 404; viewer cannot write -> 403; production refuses', async () => {
    expect((await call(api.projectsList, 'GET', '/p', { who: null })).status).toBe(401);
    expect((await call(api.projectsList, 'GET', '/p', { who: { org: B.org, user: A.editor } })).status).toBe(404);
    const r = await call(api.projectsCreate, 'POST', '/p', { who: { org: A.org, user: A.viewer }, body: { name: 'x' } });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'forbidden', status: 403 });
    process.env.LB_DEV_AUTH = '0';
    expect((await call(api.projectsList, 'GET', '/p')).status).toBe(501);
    process.env.LB_DEV_AUTH = '1';
  });
  it('validation errors are problem+json with field paths; bad JSON is 400', async () => {
    const r = await call(api.projectsCreate, 'POST', '/p', { body: { name: '' } });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: 'validation_failed', fields: [{ path: 'name' }] });
    const res = await api.projectsCreate(new Request('http://t/p', { method: 'POST', headers: { 'x-org-id': A.org, 'x-user-id': A.editor, 'idempotency-key': 'k' }, body: '{nope' }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
  it('idempotency: replay returns stored response; same key + different body -> 409; missing key -> 400', async () => {
    const key = uuidv7();
    const a = await call(api.projectsCreate, 'POST', '/p', { body: { name: 'idem' }, idem: key });
    const b = await call(api.projectsCreate, 'POST', '/p', { body: { name: 'idem' }, idem: key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect((await call(api.projectsCreate, 'POST', '/p', { body: { name: 'other' }, idem: key })).json).toMatchObject({ code: 'idempotency_key_reused' });
    expect((await call(api.projectsCreate, 'POST', '/p', { body: { name: 'x' }, idem: false })).json).toMatchObject({ code: 'idempotency_key_required' });
  });
});

describe('workflow over the API', () => {
  const bin = buildElf({ needed: ['libc.so.6'] });
  it('project -> upload -> seal -> inspect; execution is gated with an actionable error', async () => {
    const p = await ok(call(api.projectsCreate, 'POST', '/p', { body: { name: 'wf', objectives: 'o' } }), 201);
    ids.pid = p.id;
    expect(p.progress).toMatchObject({ stage: 'import', completed_steps: 0, needs_input: [{ step: 'import', code: 'source_required' }] });
    const up = await ok(call(api.uploadCreate, 'POST', '/u', { params: { pid: ids.pid }, body: { filename: 'tool', size: bin.length, sha256: sha(bin) } }), 201);
    expect(up.headers['x-amz-checksum-sha256']).toBeTruthy();
    // completing before the bytes arrive is refused
    expect((await call(api.uploadComplete, 'POST', '/c', { params: { uid: up.upload_id } })).json).toMatchObject({ code: 'upload_missing' });
    const f = up.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bin);
    expect(await ok(call(api.uploadComplete, 'POST', '/c', { params: { uid: up.upload_id } }))).toEqual({ status: 'received' });
    const rev = await ok(call(api.sourceCreate, 'POST', '/s', { params: { pid: ids.pid }, body: { artifacts: [{ upload_id: up.upload_id, path: 'bin/tool', role: 'primary_executable' }] } }), 201);
    ids.sid = rev.id;
    expect(rev.jobs[0].kind).toBe('inspect');
    await drain(env, ['inspect']);
    const st = await ok(call(api.sourceGet, 'GET', '/s', { params: { sid: ids.sid } }));
    expect(st.eligibility.analysis.status).toBe('eligible');
    expect(st.eligibility.execution).toMatchObject({ status: 'not_permitted', reasons: ['execution_disabled'] });
    const probe = await call(api.sourceProbe, 'POST', '/p', { params: { sid: ids.sid }, body: { environment_id: uuidv7() } });
    expect(probe.status).toBe(409);
    expect(probe.json).toMatchObject({ code: 'execution_not_permitted', action: { kind: 'enable_setting', setting: 'execution_enabled', role_required: 'admin' } });
  });
  it('rejects bad seals: two primaries, unsafe path, unreceived upload', async () => {
    const mk = async (b: Buffer) => { const u = await ok(call(api.uploadCreate, 'POST', '/u', { params: { pid: ids.pid }, body: { filename: 'x', size: b.length, sha256: sha(b) } }), 201); const f = u.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, b); await call(api.uploadComplete, 'POST', '/c', { params: { uid: u.upload_id } }); return u.upload_id as string; };
    const [a, b] = [await mk(Buffer.from('a')), await mk(Buffer.from('b'))];
    expect((await call(api.sourceCreate, 'POST', '/s', { params: { pid: ids.pid }, body: { artifacts: [{ upload_id: a, path: 'x', role: 'primary_executable' }, { upload_id: b, path: 'y', role: 'primary_executable' }] } })).json.code).toBe('primary_required');
    expect((await call(api.sourceCreate, 'POST', '/s', { params: { pid: ids.pid }, body: { artifacts: [{ upload_id: a, path: '../evil', role: 'primary_executable' }] } })).json.code).toBe('invalid_path');
    // hash mismatch: bytes differ from the declared hash
    const bad = await ok(call(api.uploadCreate, 'POST', '/u', { params: { pid: ids.pid }, body: { filename: 'x', size: 3, sha256: sha(Buffer.from('zzz')) } }), 201);
    const f = bad.url.replace('file://', ''); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'abc');
    await call(api.uploadComplete, 'POST', '/c', { params: { uid: bad.upload_id } });
    expect((await call(api.sourceCreate, 'POST', '/s', { params: { pid: ids.pid }, body: { artifacts: [{ upload_id: bad.upload_id, path: 'x', role: 'primary_executable' }] } })).json.code).toBe('hash_mismatch');
  });
  it('scope: If-Match required (428), stale (412); approval is single-shot; module needs approved scope', async () => {
    const doc = { workflow: { name: 'hello', invocation: { argv_template: [], stdin: 'none' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'greet', label: 'Print greeting', statement: 'Prints a greeting', basis: 'observed' }] };
    expect((await call(api.scopeDraftPut, 'PUT', '/d', { params: { pid: ids.pid }, body: { document: doc } })).status).toBe(428);
    expect((await call(api.scopeDraftPut, 'PUT', '/d', { params: { pid: ids.pid }, body: { document: { nope: 1 } }, headers: { 'if-match': '"v0"' } })).json.code).toBe('validation_failed');
    const v1 = await call(api.scopeDraftPut, 'PUT', '/d', { params: { pid: ids.pid }, body: { document: doc }, headers: { 'if-match': '"v0"' } });
    expect(v1.status).toBe(200); expect(v1.headers.get('etag')).toBe('"v1"');
    expect((await call(api.scopeDraftPut, 'PUT', '/d', { params: { pid: ids.pid }, body: { document: doc }, headers: { 'if-match': '"v0"' } })).status).toBe(412);
    expect((await call(api.scopeDraftGet, 'GET', '/d', { params: { pid: ids.pid } })).headers.get('etag')).toBe('"v1"');
    const rev = await ok(call(api.scopeRevisionCreate, 'POST', '/r', { params: { pid: ids.pid }, body: { from_draft_version: 1 } }), 201);
    expect((await ok(call(api.scopeRevisionGet, 'GET', '/r', { params: { rid: rev.id } }))).document.behaviors[0].label).toBe('Print greeting');
    ids.scope = rev.id;
    const files = [{ path: 'src/index.ts', content: "export async function run() { return { stdout: 'hi\\n' }; }\n" }];
    expect((await call(api.moduleCreate, 'POST', '/m', { params: { pid: ids.pid }, body: { origin: 'customer_upload', scope_revision_id: ids.scope, files } })).json.code).toBe('scope_not_approved');
    expect((await call(api.scopeDecision, 'POST', '/x', { params: { rid: ids.scope }, body: { decision: 'approved', document_sha256: 'a'.repeat(64) } })).json.code).toBe('digest_mismatch');
    await ok(call(api.scopeDecision, 'POST', '/x', { params: { rid: ids.scope }, body: { decision: 'approved', document_sha256: rev.document_sha256 } }));
    expect((await call(api.scopeDecision, 'POST', '/x', { params: { rid: ids.scope }, body: { decision: 'approved', document_sha256: rev.document_sha256 } })).json.code).toBe('already_decided');
    expect((await call(api.moduleCreate, 'POST', '/m', { params: { pid: ids.pid }, body: { origin: 'customer_upload', scope_revision_id: ids.scope, files: [{ path: 'src/index.ts', content: "import x from 'lodash'" }] } })).json.code).toBe('disallowed_import');
    const m = await ok(call(api.moduleCreate, 'POST', '/m', { params: { pid: ids.pid }, body: { origin: 'customer_upload', scope_revision_id: ids.scope, files } }), 201);
    ids.mid = m.id;
    expect(m).toMatchObject({ is_current: true, build: { status: 'building' } });
    await drain(env, ['build']);
    expect((await ok(call(api.moduleGet, 'GET', '/m', { params: { mid: ids.mid } }))).build.status).toBe('succeeded');
    expect((await ok(call(api.moduleBuilds, 'GET', '/b', { params: { mid: ids.mid } })))[0]).toMatchObject({ attempt: 1, status: 'succeeded' });
    expect(await ok(call(api.moduleFile, 'GET', `/api/v1/module-revisions/${ids.mid}/files/src/index.ts`, { params: { mid: ids.mid } }))).toMatchObject({ path: 'src/index.ts', encoding: 'utf-8' });
  });
  it('cases, user-supplied reference, policy, case set, verification, export', async () => {
    const tc = await ok(call(api.testCaseCreate, 'POST', '/t', { params: { pid: ids.pid }, body: { name: 'hello', input: { argv: [] } } }), 201);
    ids.tc = tc.id;
    expect((await call(api.testCaseCreate, 'POST', '/t', { params: { pid: ids.pid }, body: { name: 'dup', input: { argv: [] } } })).json).toMatchObject({ id: tc.id, reused: true }); // same input digest
    expect((await call(api.referenceSupply, 'POST', '/r', { params: { tcid: ids.tc }, body: { provenance: 'user_supplied', observation: { exit: { code: 0, signal: null }, stdout: { text: 'hi\n' } }, attestation: '' } })).status).toBe(422);
    const ref = await ok(call(api.referenceSupply, 'POST', '/r', { params: { tcid: ids.tc }, body: { provenance: 'user_supplied', observation: { exit: { code: 0, signal: null }, stdout: { text: 'hi\n' } }, attestation: 'copied from prod log OPS-112' } }), 201);
    await ok(call(api.policyCreate, 'POST', '/p', { params: { pid: ids.pid }, body: {} }), 201);
    expect((await call(api.policyCreate, 'POST', '/p', { params: { pid: ids.pid }, body: { rules: { engine: '1.1.0', stderr: { mode: 'ignore' } } } })).json.code).toBe('invalid_policy');
    await ok(call(api.caseSetCreate, 'POST', '/c', { params: { pid: ids.pid }, body: { set: [{ test_case_id: ids.tc, reference_output_id: ref.id }] } }), 201);
    const run = await ok(call(api.verificationCreate, 'POST', '/v', { params: { pid: ids.pid }, body: { environment_id: ids.replEnv } }), 202);
    ids.vr = run.run_id;
    await drain(env, ['verify']);
    const r = await ok(call(api.verificationGet, 'GET', '/v', { params: { vrid: ids.vr } }));
    expect(r).toMatchObject({ completeness: 'complete', summary: { match: 1 }, applies_to_current: true, stale_reasons: [] });
    const res = await ok(call(api.verificationResults, 'GET', '/v?outcome=match', { params: { vrid: ids.vr } }));
    expect(res.items).toHaveLength(1);
    ids.rs = res.items[0].id;
    const one = await ok(call(api.verificationResultGet, 'GET', '/r', { params: { rsid: ids.rs } }));
    expect(one).toMatchObject({ id: ids.rs, outcome: 'match', raw_equal: true, normalization_trace: [], differences: [], reference: { provenance: 'user_supplied' } });
    expect(one.actual_digests.stdout).toMatch(/^[0-9a-f]{64}$/);
    expect((await call(api.verificationResultGet, 'GET', '/r', { params: { rsid: uuidv7() } })).status).toBe(404);
    expect((await ok(call(api.verificationCreate, 'POST', '/v', { params: { pid: ids.pid }, body: { environment_id: ids.replEnv } }), 202)).reused).toBe(true);

    expect((await call(api.exportCreate, 'POST', '/e', { params: { pid: ids.pid }, body: { verification_run_id: uuidv7() } })).status).toBe(404);
    const ex = await ok(call(api.exportCreate, 'POST', '/e', { params: { pid: ids.pid }, body: { verification_run_id: ids.vr } }), 202);
    ids.eid = ex.export_id; ids.job = ex.job_id;
    expect((await ok(call(api.exportGet, 'GET', '/e', { params: { eid: ids.eid } }))).status).toBe('building');
    expect((await call(api.exportDownload, 'GET', '/e', { params: { eid: ids.eid } })).json.code).toBe('export_not_ready');
    await drain(env, ['export']);
    const g = await ok(call(api.exportGet, 'GET', '/e', { params: { eid: ids.eid } }));
    expect(g).toMatchObject({ status: 'ready', download_url: `/api/v1/exports/${ids.eid}/download` });
    const dl = await call(api.exportDownload, 'GET', '/e', { params: { eid: ids.eid } }).then(async (x) => x);
    expect(dl.status).toBe(302);
    expect(dl.headers.get('location')).toMatch(/^file:\/\//);
  });
  it('progress is derived from backend state; activity cursor works; blobs are project-scoped', async () => {
    const p = await ok(call(api.projectGet, 'GET', '/p', { params: { pid: ids.pid } }));
    expect(p.progress).toMatchObject({ completed_steps: 5 });
    const act = await ok(call(api.activity, 'GET', '/a', { params: { pid: ids.pid } }));
    expect(act.items.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['source_revision.sealed', 'verification.finished', 'export.ready']));
    expect((await ok(call(api.activity, 'GET', `/a?after=${act.next_cursor}`, { params: { pid: ids.pid } }))).items).toEqual([]);
    const m = (await ok(call(api.moduleGet, 'GET', '/m', { params: { mid: ids.mid } }))).file_manifest[0].sha256;
    expect((await call(api.blobGet, 'GET', '/b?inline=1', { params: { pid: ids.pid, sha: m } })).json).toMatchObject({ encoding: 'utf-8' });
    expect((await call(api.blobGet, 'GET', '/b', { params: { pid: ids.pid, sha: m } })).status).toBe(302);
    expect((await call(api.blobGet, 'GET', '/b', { params: { pid: ids.pid, sha: 'f'.repeat(64) } })).status).toBe(404);
    expect((await call(api.blobGet, 'GET', '/b', { who: { org: B.org, user: B.editor }, params: { pid: ids.pid, sha: m } })).status).toBe(404);
  });
  it('cancel: only queued/running jobs; viewers cannot; delete tombstones the project (admin only)', async () => {
    expect((await call(api.jobCancel, 'POST', '/j', { params: { jid: ids.job } })).json.code).toBe('not_cancellable'); // already succeeded
    expect((await call(api.jobGet, 'GET', '/j', { params: { jid: ids.job } })).json).toMatchObject({ status: 'succeeded' });
    const tmp = await ok(call(api.projectsCreate, 'POST', '/p', { body: { name: 'tmp' } }), 201);
    expect((await call(api.projectDelete, 'DELETE', '/p', { params: { pid: tmp.id } })).status).toBe(403); // editor
    expect((await call(api.projectDelete, 'DELETE', '/p', { who: { org: A.org, user: A.admin }, params: { pid: tmp.id } })).status).toBe(204);
    expect((await call(api.projectGet, 'GET', '/p', { params: { pid: tmp.id } })).status).toBe(404);
  });
});

describe('cross-tenant sweep: every generated route, org B (admin there) asking for org A resources', () => {
  const PARAM: Record<string, string> = { pid: 'pid', sid: 'sid', rid: 'scope', mid: 'mid', tcid: 'tc', vrid: 'vr', rsid: 'rs', eid: 'eid', jid: 'job', uid: 'pid', sha: 'sha', member: 'memberA' };
  const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('route.ts') ? [p] : []; });
  const BODY: Record<string, unknown> = {
    uploadCreate: { filename: 'x', size: 1, sha256: 'a'.repeat(64) }, sourceCreate: { artifacts: [{ upload_id: uuidv7(), path: 'x', role: 'primary_executable' }] }, sourceConsent: { acknowledge: 'I am authorized to run this' },
    sourceProbe: { environment_id: uuidv7() }, analysisRunCreate: { kind: 'index' }, functionNameSuggest: { finding_id: uuidv7() }, scopeDraftPut: { document: { workflow: { name: 'x', invocation: { argv_template: [] } }, interface: { language: 'typescript' } } }, scopeRevisionCreate: { from_draft_version: 1 },
    scopeDecision: { decision: 'approved', document_sha256: 'a'.repeat(64) }, moduleCreate: { origin: 'customer_upload', scope_revision_id: uuidv7(), files: [{ path: 'src/index.ts', content: 'x' }] },
    testCaseCreate: { name: 'x', input: {} }, referenceCapture: { source_revision_id: uuidv7(), environment_id: uuidv7(), test_case_ids: [uuidv7()] },
    referenceSupply: { provenance: 'user_supplied', observation: { exit: { code: 0, signal: null } }, attestation: 'x' }, caseSetCreate: { set: [{ test_case_id: uuidv7(), reference_output_id: null }] },
    memberPatch: { role: 'viewer' }, policyCreate: {}, verificationCreate: { environment_id: uuidv7() }, exportCreate: { verification_run_id: uuidv7() },
  };
  it('returns 404 for all of them (and never leaks via 403 or 200)', async () => {
    ids.memberA = A.viewer; // a user who belongs to org A only
    const files = walk(join(root, 'app/api/v1'));
    expect(files.length).toBeGreaterThanOrEqual(30);
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const params: Record<string, string> = {};
      for (const m of f.matchAll(/\[(?:\.\.\.)?(\w+)\]/g)) params[m[1]] = ids[PARAM[m[1]]] ?? ids.pid;
      params.sha = ids.sha ?? sha(Buffer.from('x'));
      for (const m of src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = api\.(\w+);/g)) {
        const [, method, name] = m;
        // Collection/org routes are scoped to the caller's own org by construction (the org comes from the verified membership); tests/api/s7-admin.test.ts covers them.
        if (['projectsList', 'projectsCreate', 'orgGet', 'orgPatch', 'membersList', 'memberAdd', 'auditEvents'].includes(name)) continue;
        const handler = (api as Record<string, any>)[name];
        const headers = name === 'scopeDraftPut' ? { 'if-match': '"v1"' } : undefined;
        const r = await call(handler, method, name === 'moduleFile' ? `/api/v1/module-revisions/${ids.mid}/files/src/index.ts` : '/x', { who: { org: B.org, user: B.editor }, params, body: BODY[name], headers });
        expect(r.status, `${method} ${f} (${name}) -> ${JSON.stringify(r.json)}`).toBe(404);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(27);
  });
});
