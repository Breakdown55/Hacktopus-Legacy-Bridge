import { Pool, type PoolClient } from 'pg';
import { API_ROLE, assertOrgId, type Db } from './db';

type Q = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };

function wrap(q: Q, tx: Db['tx'], withOrg: Db['withOrg']): Db {
  return {
    async query<T>(text: string, params?: unknown[]) { return (await q.query(text, params)).rows as T[]; },
    async exec(text) { await q.query(text); },
    tx,
    withOrg,
  };
}
const nested = (what: string) => () => { throw new Error(`${what} is not supported inside this connection`); };

/** Runs the callback in BEGIN/COMMIT on one client. */
async function transaction<T>(c: PoolClient, fn: (db: Db) => Promise<T>): Promise<T> {
  const inner: Db = wrap(c, nested('nested transactions'), nested('withOrg'));
  try {
    await c.query('BEGIN');
    const r = await fn(inner);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * `role` makes every pooled connection start as that role (startup option `-c role=...`, verified on PostgreSQL 16).
 * Workers use it to connect as `lb_worker`; defaults to LB_DB_ROLE. The login role must be a member of the target role.
 */
export function createPgDb(connectionString = process.env.DATABASE_URL, opts: { role?: string } = {}): Db & { close(): Promise<void> } {
  const role = opts.role ?? (process.env.LB_DB_ROLE || undefined);
  if (role && !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('invalid database role name');
  const pool = new Pool({ connectionString, ...(role ? { options: `-c role=${role}` } : {}) });
  const db = wrap(pool, async (fn) => {
    const c = await pool.connect();
    try { return await transaction(c, fn); } finally { c.release(); }
  }, async (orgId, fn) => {
    const org = assertOrgId(orgId);
    const c = await pool.connect();
    let clean = false;
    try {
      await c.query(`SET ROLE ${API_ROLE}`);
      await c.query("SELECT set_config('app.org_id', $1, false)", [org]);
      const scoped: Db = wrap(c, (f) => transaction(c, f), nested('withOrg'));
      return await fn(scoped);
    } finally {
      // A connection that still carries another org's scope must never return to the pool.
      try { await c.query('RESET ROLE'); await c.query('RESET app.org_id'); clean = true; } catch { /* destroyed below */ }
      c.release(!clean);
    }
  });
  return Object.assign(db, { close: () => pool.end() });
}
