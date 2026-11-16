/** `last_activity_at` follows what a person did, and the project list is ordered by it. Runs on PGlite unless TEST_DATABASE_URL is set. */
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../server/db/db';

process.env.LB_DEV_AUTH = '1';
const org = uuidv7(), user = uuidv7();
let db: Db;
async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, o: { body?: unknown; params?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': user };
  if (method === 'POST') headers['idempotency-key'] = uuidv7();
  const res = await h(new Request(o.url ?? 'http://t/x', { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('project last activity', () => {
  beforeAll(async () => {
    db = await testDb();
    setApp({ db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'lb-act-'))) } as never);
    await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [org]);
    await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [org, user]);
  });

  it('moves when a person adds something, ignores template cases, and orders the list', async () => {
    const make = async (name: string) => (await call(api.projectsCreate, 'POST', { body: { name } })).json.id as string;
    const older = await make('older'), newer = await make('newer');
    // Same creation order as the list's old behavior: newest created first.
    const first = await call(api.projectsList, 'GET', { url: 'http://t/projects?limit=10' });
    expect(first.json.items.map((p: { name: string }) => p.name)).toEqual(['newer', 'older']);

    // A template (automatic) test case is not input from a person.
    const before = (await call(api.projectGet, 'GET', { params: { pid: older } })).json.last_activity_at;
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k') ON CONFLICT DO NOTHING", [org, 'a'.repeat(64)]);
    await db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin,created_at) VALUES ($1,$2,$3,'auto','{}','d1','template', now() + interval '1 hour')", [uuidv7(), org, older]);
    expect((await call(api.projectGet, 'GET', { params: { pid: older } })).json.last_activity_at).toBe(before);

    // A test case a person wrote is.
    await db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin,created_at) VALUES ($1,$2,$3,'mine','{}','d2','user', now() + interval '1 hour')", [uuidv7(), org, older]);
    const after = (await call(api.projectGet, 'GET', { params: { pid: older } })).json.last_activity_at;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    const second = await call(api.projectsList, 'GET', { url: 'http://t/projects?limit=10' });
    expect(second.json.items.map((p: { name: string }) => p.name)).toEqual(['older', 'newer']);
  });

  it('pages through the activity order without repeats or gaps', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call(api.projectsCreate, 'POST', { body: { name: 'p' + i } })).json.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { json: { items: { id: string }[]; next_cursor: string | null } } = await call(api.projectsList, 'GET', { url: 'http://t/projects?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '') });
      seen.push(...page.json.items.map(p => p.id));
      cursor = page.json.next_cursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
  });
});
