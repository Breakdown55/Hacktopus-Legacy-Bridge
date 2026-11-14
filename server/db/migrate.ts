import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';

const dir = fileURLToPath(new URL('./migrations', import.meta.url));

/** Applies pending *.sql migrations in filename order, each in one transaction, tracked in lb_migrations. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS lb_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM lb_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.tx(async (t) => {
      await t.exec(readFileSync(`${dir}/${f}`, 'utf8'));
      await t.query('INSERT INTO lb_migrations(name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
