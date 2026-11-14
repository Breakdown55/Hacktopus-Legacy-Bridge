import type { Db } from '../db/db';
import { uuidv7 } from '../db/ids';

export interface EnvDef { name: string; version: number; role: 'original' | 'replacement' | 'build' | 'analysis'; image_digest: string; arch: string; controls: Record<string, unknown> }

/** Platform-managed environments (global, immutable). Idempotent by (name, version). */
export async function ensureEnvironment(db: Db, e: EnvDef): Promise<string> {
  const r = await db.query<{ id: string }>('SELECT id FROM execution_environments WHERE name=$1 AND version=$2', [e.name, e.version]);
  if (r[0]) return r[0].id;
  const id = uuidv7();
  await db.query('INSERT INTO execution_environments(id,name,version,role,image_digest,arch,controls) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, e.name, e.version, e.role, e.image_digest, e.arch, JSON.stringify(e.controls)]);
  return id;
}

export const CONTROLS = { tz: 'UTC', locale: 'C.UTF-8', faketime: '2000-01-01 00:00:00', uid: 10001, limits: { cpus: 1, memoryMiB: 512, pids: 64 } };
