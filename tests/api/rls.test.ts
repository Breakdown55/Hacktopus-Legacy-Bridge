/**
 * S7 defense in depth (plan §3.10, §8.2): row-level security confines a request to its organization even when a query forgets its org filter.
 * The checks run as role `lb_api` with `app.org_id` set to org B, using RAW SQL with no org filter (i.e. repository scoping bypassed).
 * Superusers bypass RLS, so every isolation assertion goes through Db.withOrg (SET ROLE lb_api), never the owner connection.
 * Substitutes: default run is PGlite (one connection). Isolation between POOLED connections (a scoped connection returned to the pool
 * carries no scope) is only proven with TEST_DATABASE_URL on real PostgreSQL. RDS BYPASSRLS availability is unverified, so
 * policies admit lb_worker, lb_purge and lb_migrate by role name instead.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { api } from '../../server/api/handlers';
import { setApp } from '../../server/app';
import { FsBlobStore } from '../../server/storage/fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LB_DEV_AUTH = '1';
const A = uuidv7(), B = uuidv7(), userA = uuidv7(), userB = uuidv7(), projA = uuidv7(), projB = uuidv7();
const SHA = 'a'.repeat(64);
let db: Db;
let tables: string[] = [];

beforeAll(async () => {
  db = await testDb();
  setApp({ db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'rls-blobs-'))) });
  for (const o of [A, B]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  for (const [o, u, p] of [[A, userA, projA], [B, userB, projB]]) {
    await db.query('INSERT INTO users(id,email) VALUES ($1,$2)', [u, `${u}@x`]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [o, u]);
    await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [p, o]);
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [o, SHA]);
    await db.query("INSERT INTO scope_drafts(project_id,org_id,document) VALUES ($1,$2,'{}')", [p, o]);
    await db.query("INSERT INTO events(org_id,project_id,type) VALUES ($1,$2,'t')", [o, p]);
    await db.query("INSERT INTO idempotency_keys(org_id,user_id,key,request_sha256,response_status) VALUES ($1,$2,'k','h',200)", [o, u]);
    await db.query("INSERT INTO jobs(id,org_id,project_id,kind) VALUES ($1,$2,$3,'inspect')", [uuidv7(), o, p]);
    await db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin) VALUES ($1,$2,$3,'c','{}','d','user')", [uuidv7(), o, p]);
  }
  tables = (await db.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'org_id' ORDER BY 1`)).map((r) => r.table_name);
});

describe('S7: row-level security (as lb_api, raw SQL, no org filter)', () => {
  it('every table with an org_id column has RLS enabled AND forced, so a new table cannot silently skip it', async () => {
    expect(tables).toContain('projects');
    expect(tables).toContain('memberships');
    const rows = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      'SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = $2', [[...tables, 'organizations'], 'r']);
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables, 'organizations'].sort());
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.query<{ tablename: string }>("SELECT tablename FROM pg_policies WHERE policyname = 'lb_org_isolation'");
    expect(policies.map((p) => p.tablename).sort()).toEqual([...tables, 'organizations'].sort());
  });

  it('as org B, org A has no visible rows in any table (select without an org filter)', async () => {
    const seen = await db.withOrg(B, async (s) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = (await s.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [A]))[0].n;
      out.organizations = (await s.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE id = $1', [A]))[0].n;
      return out;
    });
    for (const [t, n] of Object.entries(seen)) expect(n, `${t} leaked org A rows`).toBe(0);
    // not vacuous: org A really has rows, visible to A and to the owner
    const asA = await db.withOrg(A, async (s) => (await s.query<{ n: number }>('SELECT count(*)::int AS n FROM projects'))[0].n);
    expect(asA).toBe(1);
    const asOwner = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM projects'))[0].n;
    expect(asOwner).toBe(2);
    // an unfiltered select as B returns only B's rows
    expect(await db.withOrg(B, (s) => s.query<{ org_id: string }>('SELECT org_id FROM projects'))).toEqual([{ org_id: B }]);
    expect(await db.withOrg(B, (s) => s.query<{ org_id: string }>('SELECT org_id FROM memberships'))).toEqual([{ org_id: B }]);
  });

  it('as org B, writing to org A fails or touches zero rows', async () => {
    await db.withOrg(B, async (s) => {
      await expect(s.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'x')", [uuidv7(), A])).rejects.toMatchObject({ code: '42501' });
      await expect(s.query("INSERT INTO events(org_id,type) VALUES ($1,'t')", [A])).rejects.toMatchObject({ code: '42501' });
    });
    const touched = await db.withOrg(B, async (s) => ({
      update: (await s.query("UPDATE projects SET name='hacked' WHERE org_id = $1 RETURNING id", [A])).length,
      deleteProj: (await s.query('DELETE FROM projects WHERE org_id = $1 RETURNING id', [A])).length,
      deleteJob: (await s.query('DELETE FROM jobs WHERE org_id = $1 RETURNING id', [A])).length,
      moveOwn: (await s.query('UPDATE projects SET org_id = $1 WHERE id = $2 RETURNING id', [A, projB]).catch((e: { code?: string }) => e.code)),
    }));
    expect(touched).toMatchObject({ update: 0, deleteProj: 0, deleteJob: 0, moveOwn: '42501' }); // cannot move B's row into A either
    expect((await db.query<{ name: string }>('SELECT name FROM projects WHERE id=$1', [projA]))[0].name).toBe('p');
  });

  it('with no org set (or a malformed one), nothing is visible and the role is reset afterwards', async () => {
    await expect(db.withOrg('not-a-uuid', async () => 1)).rejects.toThrow('invalid org id');
    await expect(db.withOrg(`${A}'; DROP TABLE projects; --`, async () => 1)).rejects.toThrow('invalid org id');
    // withOrg(B) then the owner connection again: the scope must not leak into the next user of the connection
    await db.withOrg(B, async () => undefined);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM projects'))[0].n).toBe(2);
    expect((await db.query<{ u: string }>('SELECT current_user AS u'))[0].u).not.toBe('lb_api');
    expect((await db.query<{ v: string | null }>("SELECT nullif(current_setting('app.org_id', true), '') AS v"))[0].v).toBeNull();
    // a failing callback also resets
    await expect(db.withOrg(B, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await db.query<{ u: string }>('SELECT current_user AS u'))[0].u).not.toBe('lb_api');
  });

  it('transactions work inside a scope and roll back cleanly', async () => {
    await db.withOrg(B, async (s) => {
      await expect(s.tx(async (t) => {
        await t.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'rolled-back')", [uuidv7(), B]);
        throw new Error('abort');
      })).rejects.toThrow('abort');
      expect((await s.query('SELECT 1 FROM projects WHERE name=$1', ['rolled-back'])).length).toBe(0);
      await s.tx(async (t) => { await t.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'kept')", [uuidv7(), B]); });
      expect((await s.query('SELECT 1 FROM projects WHERE name=$1', ['kept'])).length).toBe(1);
    });
  });

  it('concurrent scoped sessions for different orgs never see each other', async () => {
    const run = (org: string, other: string) => db.withOrg(org, async (s) => {
      await new Promise((r) => setTimeout(r, 5));
      const own = (await s.query<{ org_id: string }>('SELECT org_id FROM projects')).map((r) => r.org_id);
      const foreign = (await s.query('SELECT 1 FROM projects WHERE org_id = $1', [other])).length;
      return { own: [...new Set(own)], foreign };
    });
    const results = await Promise.all([run(A, B), run(B, A), run(A, B), run(B, A), run(A, B), run(B, A)]);
    results.forEach((r, i) => expect(r, `session ${i}`).toEqual({ own: [i % 2 ? B : A], foreign: 0 }));
  });

  it('the real handlers work under RLS and keep returning 404 for another org', async () => {
    const hdr = (org: string, user: string) => ({ 'x-org-id': org, 'x-user-id': user, 'content-type': 'application/json' });
    const asA = await api.projectGet(new Request('http://t/p', { headers: hdr(A, userA) }), { params: Promise.resolve({ pid: projA }) });
    expect(asA.status).toBe(200);
    const cross = await api.projectGet(new Request('http://t/p', { headers: hdr(B, userB) }), { params: Promise.resolve({ pid: projA }) });
    expect(cross.status).toBe(404); // org A's project is invisible to org B, not forbidden
    const stranger = await api.projectGet(new Request('http://t/p', { headers: hdr(A, userB) }), { params: Promise.resolve({ pid: projA }) });
    expect(stranger.status).toBe(404); // userB is not a member of A: membership is checked inside A's scope and not found
    const unknownOrg = await api.projectGet(new Request('http://t/p', { headers: hdr(uuidv7(), userB) }), { params: Promise.resolve({ pid: projA }) });
    expect(unknownOrg.status).toBe(404);
  });
});
