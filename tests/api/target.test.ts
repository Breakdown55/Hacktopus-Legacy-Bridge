/**
 * Project packaging target: chosen at creation, returned on read, and enforced. Only TypeScript can be generated, built and verified;
 * other targets are recorded and module work is refused (409 target_not_supported). Substitute: PGlite, filesystem blob store.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { createScopeRevision, decideScope, putScopeDraft } from '../../server/domain/projects';
import type { Db } from '../../server/db/db';

process.env.LB_DEV_AUTH = '1';
const org = uuidv7(), user = uuidv7();
let db: Db;
async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, o: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': user };
  if (method === 'POST') headers['idempotency-key'] = uuidv7();
  const res = await h(new Request('http://t/x', { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function approvedScope(pid: string) {
  const src = uuidv7();
  await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k') ON CONFLICT DO NOTHING", [org, 'd'.repeat(64)]);
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, org, pid]);
  await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/tool','primary_executable',$3,1)", [src, org, 'd'.repeat(64)]);
  await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [pid, src]);
  await putScopeDraft(db, org, pid, { workflow: { name: 'w', invocation: { argv_template: [], stdin: 'text' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'b', statement: 'Does a thing', basis: 'observed' }] }, null, user);
  const scope = await createScopeRevision(db, org, pid, 1, user);
  await decideScope(db, org, pid, scope.id, 'approved', scope.document_sha256, user);
  return scope.id;
}
const FILES = [{ path: 'src/index.ts', content: 'export async function run() { return {}; }\n' }];

beforeAll(async () => {
  db = await testDb();
  setApp({ db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'target-blobs-'))) });
  await db.query("INSERT INTO organizations(id,name,external_model_allowed) VALUES ($1,'o',true)", [org]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
  await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [org, user]);
});

describe('project packaging target', () => {
  it('defaults to TypeScript, stores the chosen target, and rejects unknown ones', async () => {
    const ts = await call(api.projectsCreate, 'POST', { body: { name: 'a' } });
    expect(ts.status).toBe(201);
    expect((await call(api.projectGet, 'GET', { params: { pid: ts.json.id } })).json.target_language).toBe('typescript');
    const py = await call(api.projectsCreate, 'POST', { body: { name: 'b', target_language: 'python' } });
    expect((await call(api.projectGet, 'GET', { params: { pid: py.json.id } })).json.target_language).toBe('python');
    expect((await call(api.projectsCreate, 'POST', { body: { name: 'c', target_language: 'cobol' } })).status).toBe(422);
  });

  it('refuses generation and uploads for a target that is not available, and allows TypeScript', async () => {
    const py = (await call(api.projectsCreate, 'POST', { body: { name: 'py', target_language: 'python' } })).json.id;
    const scope = await approvedScope(py);
    const generated = await call(api.moduleCreate, 'POST', { params: { pid: py }, body: { origin: 'generated', scope_revision_id: scope } });
    expect(generated).toMatchObject({ status: 409, json: { code: 'target_not_supported' } });
    const uploaded = await call(api.moduleCreate, 'POST', { params: { pid: py }, body: { origin: 'customer_upload', scope_revision_id: scope, files: FILES } });
    expect(uploaded).toMatchObject({ status: 409, json: { code: 'target_not_supported' } });
    expect(await db.query('SELECT 1 FROM module_revisions WHERE project_id=$1', [py])).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM jobs WHERE project_id=$1 AND kind='generate'", [py])).toHaveLength(0);

    const ts = (await call(api.projectsCreate, 'POST', { body: { name: 'ts' } })).json.id;
    const ok = await call(api.moduleCreate, 'POST', { params: { pid: ts }, body: { origin: 'customer_upload', scope_revision_id: await approvedScope(ts), files: FILES } });
    expect(ok.status).toBe(201);
  });
});
