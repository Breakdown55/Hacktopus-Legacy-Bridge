import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Pool } from 'pg';
import type { Db } from '../../server/db/db';
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
  const wrap = (q: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }, tx: Db['tx']): Db => ({
    async query<T>(text: string, params?: unknown[]) { return (await q.query(text, params as never)).rows as T[]; },
    async exec(text) { await q.exec(text); },
    tx,
  });
  const db = wrap(raw, (fn) => raw.transaction((t) => fn(wrap(t as never, () => { throw new Error('nested tx'); }))));
  await migrate(db);
  return db;
}
