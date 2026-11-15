import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Pool } from 'pg';
import { API_ROLE, assertOrgId, type Db } from '../../server/db/db';
import { migrate } from '../../server/db/migrate';
import { createPgDb } from '../../server/db/pg';

/**
 * A migrated database for tests.
 * - TEST_DATABASE_URL set: a fresh database on that real PostgreSQL server (true concurrency, real driver).
 * - otherwise: PGlite (PostgreSQL in WASM, single connection).
 */
export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const name = `lb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const u = new URL(url); u.pathname = `/${name}`;
    const db = createPgDb(u.toString());
    await migrate(db);
    return db;
  }
  const raw = new PGlite({ extensions: { pg_trgm } });
  const nested = (what: string) => () => { throw new Error(`${what} not supported here`); };
  const wrap = (q: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }, tx: Db['tx'], withOrg: Db['withOrg']): Db => ({
    async query<T>(text: string, params?: unknown[]) { return (await q.query(text, params as never)).rows as T[]; },
    async exec(text) { await q.exec(text); },
    tx,
    withOrg,
  });
  const transaction: Db['tx'] = (fn) => raw.transaction((t) => fn(wrap(t as never, nested('nested tx'), nested('withOrg'))));
  // PGlite has ONE connection: scoped sessions are serialized so one org's role and setting can never overlap another's.
  let chain: Promise<unknown> = Promise.resolve();
  const withOrg: Db['withOrg'] = async (orgId, fn) => {
    const org = assertOrgId(orgId);
    const run = chain.then(async () => {
      await raw.exec(`SET ROLE ${API_ROLE}`);
      await raw.query("SELECT set_config('app.org_id', $1, false)", [org]);
      try { return await fn(wrap(raw, transaction, nested('withOrg'))); }
      finally { await raw.exec('RESET ROLE; RESET app.org_id'); }
    });
    chain = run.catch(() => {});
    return run;
  };
  const db = wrap(raw, transaction, withOrg);
  await migrate(db);
  return db;
}
