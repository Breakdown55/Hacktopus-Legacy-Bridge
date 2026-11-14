import type { Db } from '../db/db';
import { uuidv7 } from '../db/ids';

export interface Job {
  id: string; org_id: string; project_id: string | null; kind: string; subject_type: string | null; subject_id: string | null;
  payload: Record<string, unknown>; status: string; attempt: number; max_attempts: number; lease_owner: string | null; cancel_requested_at: string | null;
}

export const LEASE_SECONDS = 45;

export interface EnqueueInput {
  orgId: string; projectId?: string | null; kind: string; subjectType?: string; subjectId?: string;
  payload?: Record<string, unknown>; dedupeKey?: string; maxAttempts?: number; runAfter?: Date;
}

/** Enqueue; an active job with the same dedupe_key is returned instead of creating a new one. */
export async function enqueue(db: Db, i: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
  const id = uuidv7();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO jobs(id,org_id,project_id,kind,subject_type,subject_id,payload,dedupe_key,max_attempts,run_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()))
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING
     RETURNING id`,
    [id, i.orgId, i.projectId ?? null, i.kind, i.subjectType ?? null, i.subjectId ?? null, JSON.stringify(i.payload ?? {}), i.dedupeKey ?? null, i.maxAttempts ?? 3, i.runAfter ?? null],
  );
  if (rows.length) return { id, deduped: false };
  const existing = await db.query<{ id: string }>(`SELECT id FROM jobs WHERE org_id=$1 AND dedupe_key=$2 AND status IN ('queued','running')`, [i.orgId, i.dedupeKey]);
  return { id: existing[0].id, deduped: true };
}

/** Claim one queued job with a lease. SKIP LOCKED lets many workers poll without blocking each other. */
export async function claim(db: Db, worker: string, kinds?: string[]): Promise<Job | null> {
  const rows = await db.query<Job>(
    `UPDATE jobs SET status='running', attempt=attempt+1, lease_owner=$1, lease_expires_at=now() + make_interval(secs => $2),
            heartbeat_at=now(), started_at=COALESCE(started_at, now())
     WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= now() AND ($3::text[] IS NULL OR kind = ANY($3))
                 ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, org_id, project_id, kind, subject_type, subject_id, payload, status, attempt, max_attempts, lease_owner, cancel_requested_at`,
    [worker, LEASE_SECONDS, kinds ?? null],
  );
  return rows[0] ?? null;
}

/** Extends the lease. Returns cancelRequested, or null if the lease is no longer ours (stop work). */
export async function heartbeat(db: Db, jobId: string, worker: string, progress?: unknown): Promise<{ cancelRequested: boolean } | null> {
  const rows = await db.query<{ cancel_requested_at: string | null }>(
    `UPDATE jobs SET heartbeat_at=now(), lease_expires_at=now() + make_interval(secs => $3), progress=COALESCE($4::jsonb, progress)
     WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING cancel_requested_at`,
    [jobId, worker, LEASE_SECONDS, progress === undefined ? null : JSON.stringify(progress)],
  );
  return rows.length ? { cancelRequested: rows[0].cancel_requested_at !== null } : null;
}

/** Finalize only if we still own the lease; a duplicate worker affects 0 rows and must abort. */
export async function finish(db: Db, jobId: string, worker: string, r: { status: 'succeeded' | 'failed' | 'cancelled'; error?: unknown }): Promise<boolean> {
  const rows = await db.query(
    `UPDATE jobs SET status=$3, error=$4::jsonb, finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
     WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING id`,
    [jobId, worker, r.status, r.error === undefined ? null : JSON.stringify(r.error)],
  );
  return rows.length === 1;
}

/** Transient failure: requeue with exponential backoff + jitter, or fail when attempts are exhausted. */
export async function retryOrFail(db: Db, jobId: string, worker: string, error: unknown): Promise<'requeued' | 'failed' | 'lost'> {
  const rows = await db.query<{ status: string }>(
    `UPDATE jobs SET
        status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
        run_after = CASE WHEN attempt < max_attempts THEN now() + make_interval(secs => LEAST(300, power(2, attempt) * 2) * (0.75 + random() * 0.5)) ELSE run_after END,
        error=$3::jsonb, lease_owner=NULL, lease_expires_at=NULL,
        finished_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END
     WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING status`,
    [jobId, worker, JSON.stringify(error)],
  );
  return rows.length ? (rows[0].status === 'queued' ? 'requeued' : 'failed') : 'lost';
}

/** Cancel: queued jobs cancel immediately; running jobs get cancel_requested_at, observed on the next heartbeat. */
export async function cancel(db: Db, orgId: string, jobId: string): Promise<'cancelled' | 'cancel_requested' | 'noop'> {
  const q = await db.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=$1 AND org_id=$2 AND status='queued' RETURNING id`, [jobId, orgId]);
  if (q.length) return 'cancelled';
  const r = await db.query(`UPDATE jobs SET cancel_requested_at=COALESCE(cancel_requested_at, now()) WHERE id=$1 AND org_id=$2 AND status='running' RETURNING id`, [jobId, orgId]);
  return r.length ? 'cancel_requested' : 'noop';
}

/** Reaper: requeue expired leases (attempt already incremented at claim) or fail them as worker_lost. */
export async function reap(db: Db): Promise<number> {
  const rows = await db.query(
    `UPDATE jobs SET
        status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
        error = CASE WHEN attempt < max_attempts THEN error ELSE '{"code":"worker_lost"}'::jsonb END,
        finished_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END,
        lease_owner=NULL, lease_expires_at=NULL
     WHERE status='running' AND lease_expires_at < now() RETURNING id`,
  );
  return rows.length;
}
