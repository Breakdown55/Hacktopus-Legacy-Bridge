import { Pool, type PoolClient } from 'pg';
import type { Db } from './db';

function wrap(q: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, tx: Db['tx']): Db {
  return {
    async query<T>(text: string, params?: unknown[]) { return (await q.query(text, params)).rows as T[]; },
    async exec(text) { await q.query(text); },
    tx,
  };
}

export function createPgDb(connectionString = process.env.DATABASE_URL): Db & { close(): Promise<void> } {
  const pool = new Pool({ connectionString });
  const db = wrap(pool, async (fn) => {
    const c: PoolClient = await pool.connect();
    const inner: Db = wrap(c, () => { throw new Error('nested transactions are not supported'); });
    try {
      await c.query('BEGIN');
      const r = await fn(inner);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
  return Object.assign(db, { close: () => pool.end() });
}
