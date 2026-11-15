/**
 * S7 admin surface: members (last-admin protection), org settings, audit events, project tombstone, quotas, healthz.
 * Calls handlers with real Request objects (not a running HTTP server). Substitutes: PGlite by default (single connection); set TEST_DATABASE_URL
 * to run on real PostgreSQL 16. FsBlobStore stands in for S3. Auth is the dev-header scheme.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api, healthz } from '../../server/api/handlers';
import { enqueue } from '../../server/jobs/queue';
import type { Db } from '../../server/db/db';

process.env.LB_DEV_AUTH = '1';
const A = { org: uuidv7(), admin: uuidv7(), admin2: uuidv7(), editor: uuidv7(), viewer: uuidv7() };
const B = { org: uuidv7(), admin: uuidv7() };
let db: Db, store: FsBlobStore;
type Who = { org: string; user: string } | null;

async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, path: string, o: { who?: Who; body?: unknown; params?: Record<string, string> } = {}) {
  const who = o.who === undefined ? { org: A.org, user: A.admin } : o.who;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(who ? { 'x-org-id': who.org, 'x-user-id': who.user } : {}) };
  if (method === 'POST') headers['idempotency-key'] = uuidv7();
  const res = await h(new Request(`http://t${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const as = (user: string, org = A.org): Who => ({ org, user });
const events = (type: string, org = A.org) => db.query<{ actor_id: string; subject_id: string; data: Record<string, unknown> }>('SELECT actor_id, subject_id, data FROM events WHERE org_id=$1 AND type=$2 ORDER BY events.id', [org, type]);

beforeAll(async () => {
  db = await testDb();
  store = new FsBlobStore(mkdtempSync(join(tmpdir(), 's7-blobs-')));
  setApp({ db, store });
  for (const o of [A.org, B.org]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  for (const [o, u, r] of [[A.org, A.admin, 'admin'], [A.org, A.admin2, 'admin'], [A.org, A.editor, 'editor'], [A.org, A.viewer, 'viewer'], [B.org, B.admin, 'admin']]) {
    await db.query('INSERT INTO users(id,email) VALUES ($1,$2)', [u, `${u}@x`]);
    await db.query('INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,$3)', [o, u, r]);
  }
});

describe('members', () => {
  it('anyone in the org may list; only admins write', async () => {
    const list = await call(api.membersList, 'GET', '/m', { who: as(A.viewer) });
    expect(list.status).toBe(200);
    expect(list.json.items.map((m: { user_id: string }) => m.user_id).sort()).toEqual([A.admin, A.admin2, A.editor, A.viewer].sort());
    expect((await call(api.memberAdd, 'POST', '/m', { who: as(A.editor), body: { email: 'n@x.dev', role: 'viewer' } })).status).toBe(403);
    expect((await call(api.memberPatch, 'PATCH', '/m', { who: as(A.editor), params: { member: A.viewer }, body: { role: 'admin' } })).status).toBe(403);
    expect((await call(api.memberRemove, 'DELETE', '/m', { who: as(A.viewer), params: { member: A.editor } })).status).toBe(403);
  });

  it('invite creates or links a user by email (case-insensitive) and audits it', async () => {
    const r = await call(api.memberAdd, 'POST', '/m', { body: { email: 'New.Person@Example.com', role: 'editor' } });
    expect(r).toMatchObject({ status: 201, json: { email: 'new.person@example.com', role: 'editor' } });
    expect((await call(api.memberAdd, 'POST', '/m', { body: { email: 'new.person@example.com', role: 'viewer' } })).json).toMatchObject({ code: 'already_member' });
    // an existing user (belongs to another org) is linked, not duplicated
    const other = uuidv7();
    await db.query("INSERT INTO users(id,email) VALUES ($1,'linked@example.com')", [other]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'viewer')", [B.org, other]);
    expect((await call(api.memberAdd, 'POST', '/m', { body: { email: 'LINKED@Example.com', role: 'viewer' } })).json).toMatchObject({ user_id: other });
    expect((await db.query("SELECT 1 FROM users WHERE lower(email)='linked@example.com'")).length).toBe(1);
    expect((await db.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2', [A.org, other])).length).toBe(1);
    await call(api.memberRemove, 'DELETE', '/m', { params: { member: other } });
    expect((await call(api.memberAdd, 'POST', '/m', { body: { email: 'not-an-email', role: 'viewer' } })).status).toBe(422);
    const ev = await events('member.added');
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev[0]).toMatchObject({ actor_id: A.admin, subject_id: r.json.user_id, data: { role: 'editor' } });
    expect(JSON.stringify(ev)).not.toContain('example.com'); // PII stays out of the audit trail
  });

  it('role changes are audited; the last admin cannot be demoted or removed', async () => {
    const ch = await call(api.memberPatch, 'PATCH', '/m', { params: { member: A.viewer }, body: { role: 'editor' } });
    expect(ch).toMatchObject({ status: 200, json: { role: 'editor' } });
    expect((await events('member.role_changed')).at(-1)).toMatchObject({ subject_id: A.viewer, data: { from: 'viewer', to: 'editor' } });
    await call(api.memberPatch, 'PATCH', '/m', { params: { member: A.viewer }, body: { role: 'viewer' } });

    // two admins: one may step down; the other is now the last admin
    expect((await call(api.memberPatch, 'PATCH', '/m', { params: { member: A.admin2 }, body: { role: 'editor' } })).status).toBe(200);
    expect((await call(api.memberPatch, 'PATCH', '/m', { params: { member: A.admin }, body: { role: 'editor' } })).json).toMatchObject({ code: 'last_admin' });
    expect((await call(api.memberRemove, 'DELETE', '/m', { params: { member: A.admin } })).json).toMatchObject({ code: 'last_admin' });
    expect((await db.query<{ role: string }>('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2', [A.org, A.admin]))[0].role).toBe('admin');
    // restore a second admin, then removal of a non-admin and of a former admin work
    await call(api.memberPatch, 'PATCH', '/m', { params: { member: A.admin2 }, body: { role: 'admin' } });
    expect((await call(api.memberRemove, 'DELETE', '/m', { params: { member: A.viewer } })).status).toBe(204);
    expect((await events('member.removed')).at(-1)).toMatchObject({ subject_id: A.viewer, data: { role: 'viewer' } });
    expect((await call(api.memberRemove, 'DELETE', '/m', { params: { member: A.viewer } })).status).toBe(404);
  });

  it('two admins demoting each other at once leave exactly one admin', async () => {
    await db.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id IN ($2,$3)", [A.org, A.admin, A.admin2]);
    const rs = await Promise.all([
      call(api.memberPatch, 'PATCH', '/m', { who: as(A.admin), params: { member: A.admin2 }, body: { role: 'viewer' } }),
      call(api.memberPatch, 'PATCH', '/m', { who: as(A.admin2), params: { member: A.admin }, body: { role: 'viewer' } }),
    ]);
    // on PGlite the two requests serialize; on PG16 the FOR UPDATE on admin rows decides. Either way at least one admin must remain.
    expect((await db.query('SELECT 1 FROM memberships WHERE org_id=$1 AND role=$2', [A.org, 'admin'])).length).toBeGreaterThanOrEqual(1);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    await db.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id IN ($2,$3)", [A.org, A.admin, A.admin2]);
  });

  it('another org cannot see or touch these members (404)', async () => {
    expect((await call(api.memberPatch, 'PATCH', '/m', { who: as(B.admin, B.org), params: { member: A.editor }, body: { role: 'viewer' } })).status).toBe(404);
    expect((await call(api.memberRemove, 'DELETE', '/m', { who: as(B.admin, B.org), params: { member: A.editor } })).status).toBe(404);
    const seen = (await call(api.membersList, 'GET', '/m', { who: as(B.admin, B.org) })).json.items.map((m: { user_id: string }) => m.user_id);
    expect(seen).toContain(B.admin);
    for (const u of [A.admin, A.admin2, A.editor]) expect(seen).not.toContain(u);
  });
});

describe('org settings', () => {
  it('admins flip execution and external-model consent; each change is audited with old and new', async () => {
    expect((await call(api.orgGet, 'GET', '/o', { who: as(A.editor) })).json).toMatchObject({ execution_enabled: false, external_model_allowed: false, quota: { max_projects: 50 } });
    expect((await call(api.orgPatch, 'PATCH', '/o', { who: as(A.editor), body: { execution_enabled: true } })).status).toBe(403);
    const r = await call(api.orgPatch, 'PATCH', '/o', { body: { execution_enabled: true, external_model_allowed: true } });
    expect(r.json).toMatchObject({ execution_enabled: true, external_model_allowed: true });
    const ev = await events('org.setting_changed');
    expect(ev.map((e) => e.data)).toEqual(expect.arrayContaining([{ setting: 'execution_enabled', old: false, new: true }, { setting: 'external_model_allowed', old: false, new: true }]));
    await call(api.orgPatch, 'PATCH', '/o', { body: { execution_enabled: true } }); // no-op: no event
    expect((await events('org.setting_changed')).length).toBe(ev.length);
    expect((await call(api.orgPatch, 'PATCH', '/o', { body: { name: 'x' } })).status).toBe(422); // unknown keys rejected
    // B's org is unaffected
    expect((await call(api.orgGet, 'GET', '/o', { who: as(B.admin, B.org) })).json).toMatchObject({ execution_enabled: false });
  });
});

describe('audit events', () => {
  it('admin-only, filterable, paginated, scoped to the org, and free of customer data', async () => {
    expect((await call(api.auditEvents, 'GET', '/a', { who: as(A.editor) })).status).toBe(403);
    await db.query(`INSERT INTO events(org_id,actor_id,type,subject_type,subject_id,data) VALUES ($1,$2,'test.leaky','x','y',$3)`, [A.org, A.admin, JSON.stringify({ setting: 'ok', note: 'customer free text with spaces', stdout: 'secret' })]);
    const all = await call(api.auditEvents, 'GET', '/a?limit=2');
    expect(all.json.items.length).toBe(2);
    expect(all.json.next_cursor).toBeTruthy();
    const next = await call(api.auditEvents, 'GET', `/a?limit=2&cursor=${all.json.next_cursor}`);
    expect(next.json.items[0].id).not.toBe(all.json.items[0].id);
    expect(Number(next.json.items[0].id)).toBeLessThan(Number(all.json.items[1].id));
    const leaky = (await call(api.auditEvents, 'GET', '/a?type=test.leaky')).json.items;
    expect(leaky).toHaveLength(1);
    expect(leaky[0].data).toEqual({ setting: 'ok' });
    expect((await call(api.auditEvents, 'GET', '/a?type=member.added')).json.items.every((e: { type: string }) => e.type === 'member.added')).toBe(true);
    expect((await call(api.auditEvents, 'GET', '/a?project_id=nope')).status).toBe(400);
    expect((await call(api.auditEvents, 'GET', '/a', { who: as(B.admin, B.org) })).json.items.length).toBe(0);
  });
});

describe('project delete (tombstone)', () => {
  it('hides the project and everything reachable by id, cancels jobs, audits, and is admin-only', async () => {
    const created = await call(api.projectsCreate, 'POST', '/p', { body: { name: 'doomed' } });
    const pid = created.json.id as string;
    const src = uuidv7(), rev = uuidv7();
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k') ON CONFLICT DO NOTHING", [A.org, 'e'.repeat(64)]);
    await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, A.org, pid]);
    await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/t','primary_executable',$3,1)", [src, A.org, 'e'.repeat(64)]);
    await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [pid, src]);
    await db.query("INSERT INTO scope_revisions(id,org_id,project_id,number,source_revision_id,document,document_sha256,created_by) VALUES ($1,$2,$3,1,$4,'{}','d',$5)", [rev, A.org, pid, src, A.admin]).catch(() => undefined);
    const job = await enqueue(db, { orgId: A.org, projectId: pid, kind: 'build', subjectType: 'project', subjectId: pid, payload: {}, dedupeKey: `s7:${pid}` });
    expect((await call(api.jobGet, 'GET', '/j', { params: { jid: job.id } })).status).toBe(200);
    expect((await call(api.sourceGet, 'GET', '/s', { params: { sid: src } })).status).toBe(200);

    expect((await call(api.projectDelete, 'DELETE', '/p', { who: as(A.editor), params: { pid } })).status).toBe(403);
    expect((await call(api.projectDelete, 'DELETE', '/p', { who: as(B.admin, B.org), params: { pid } })).status).toBe(404);
    expect((await call(api.projectDelete, 'DELETE', '/p', { params: { pid } })).status).toBe(204);

    expect((await call(api.projectGet, 'GET', '/p', { params: { pid } })).status).toBe(404);
    expect((await call(api.projectsList, 'GET', '/p')).json.items.some((p: { id: string }) => p.id === pid)).toBe(false);
    expect((await call(api.projectDelete, 'DELETE', '/p', { params: { pid } })).status).toBe(404); // already deleted
    expect((await call(api.scopeDraftGet, 'GET', '/d', { params: { pid } })).status).toBe(404);
    expect((await call(api.sourceGet, 'GET', '/s', { params: { sid: src } })).status).toBe(404);
    expect((await call(api.jobGet, 'GET', '/j', { params: { jid: job.id } })).status).toBe(404);
    expect((await call(api.blobGet, 'GET', '/b', { params: { pid, sha: 'e'.repeat(64) } })).status).toBe(404);
    expect((await db.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [job.id]))[0].status).toBe('cancelled');
    expect((await db.query('SELECT deleted_at FROM projects WHERE id=$1', [pid]))[0]).toMatchObject({ deleted_at: expect.anything() });
    expect((await events('project.deleted')).some((e) => e.subject_id === pid && e.actor_id === A.admin)).toBe(true);
  });
});

describe('job.cancelled audit', () => {
  it('cancelling a job writes an audit event', async () => {
    const pid = (await call(api.projectsCreate, 'POST', '/p', { body: { name: 'cancel' } })).json.id as string;
    const job = await enqueue(db, { orgId: A.org, projectId: pid, kind: 'build', subjectType: 'project', subjectId: pid, payload: {}, dedupeKey: `s7c:${pid}` });
    expect((await call(api.jobCancel, 'POST', '/j', { who: as(A.editor), params: { jid: job.id } })).status).toBe(202);
    expect((await events('job.cancelled')).at(-1)).toMatchObject({ actor_id: A.editor, subject_id: job.id });
  });
});

describe('quotas (429 quota_exceeded with an action)', () => {
  const quota = (q: Record<string, number>) => db.query('UPDATE organizations SET quota=$2 WHERE id=$1', [A.org, JSON.stringify(q)]);
  it('project count honors the default and the per-org override', async () => {
    const have = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM projects WHERE org_id=$1 AND deleted_at IS NULL', [A.org]))[0].n);
    await quota({ max_projects: have });
    const r = await call(api.projectsCreate, 'POST', '/p', { body: { name: 'one too many' } });
    expect(r).toMatchObject({ status: 429, json: { code: 'quota_exceeded', action: { kind: 'quota', name: 'max_projects', limit: have, current: have } } });
    await quota({ max_projects: have + 1 });
    expect((await call(api.projectsCreate, 'POST', '/p', { body: { name: 'fits' } })).status).toBe(201);
    await quota({});
  });

  it('upload size and org storage are checked when the upload session is created', async () => {
    const pid = (await call(api.projectsCreate, 'POST', '/p', { body: { name: 'uploads' } })).json.id as string;
    const up = (size: number) => call(api.uploadCreate, 'POST', '/u', { params: { pid }, body: { filename: 'x', size, sha256: 'a'.repeat(64) } });
    await quota({ max_file_bytes: 10 });
    expect((await up(11)).json).toMatchObject({ code: 'quota_exceeded', action: { name: 'max_file_bytes', limit: 10, current: 11 } });
    expect((await up(10)).status).toBe(201);
    await quota({ max_storage_bytes: 15 });
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,100,'k2') ON CONFLICT DO NOTHING", [A.org, 'f'.repeat(64)]);
    expect((await up(1)).json).toMatchObject({ code: 'quota_exceeded', action: { name: 'max_storage_bytes', limit: 15 } });
    await quota({});
    expect((await up(10)).status).toBe(201);
  });

  it('generations per day are limited before any provider work is queued', async () => {
    const pid = (await call(api.projectsCreate, 'POST', '/p', { body: { name: 'gen' } })).json.id as string;
    await quota({ max_generations_per_day: 1 });
    await db.query("INSERT INTO events(org_id,type) VALUES ($1,'generation.requested')", [A.org]);
    const r = await call(api.moduleCreate, 'POST', '/m', { params: { pid }, body: { origin: 'generated', scope_revision_id: uuidv7() } });
    expect(r).toMatchObject({ status: 429, json: { code: 'quota_exceeded', action: { name: 'max_generations_per_day', limit: 1, current: 1 } } });
    expect(await db.query("SELECT 1 FROM jobs WHERE kind='generate'")).toHaveLength(0);
    await quota({});
  });

  it('quota overrides ignore junk values', async () => {
    await quota({ max_projects: -5, max_file_bytes: 'lots' as unknown as number });
    expect((await call(api.orgGet, 'GET', '/o')).json.quota).toMatchObject({ max_projects: 50 });
    await quota({});
  });
});

describe('healthz', () => {
  it('is unauthenticated, reports ok, and 503s when a dependency is down', async () => {
    const ok = await healthz();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok' });
    const broken = { ...store, statStaged: async () => { throw new Error('boom'); } } as unknown as FsBlobStore;
    setApp({ db, store: broken });
    const bad = await healthz();
    expect(bad.status).toBe(503);
    expect(await bad.json()).toEqual({ status: 'unavailable' });
    setApp({ db, store });
  });
});
