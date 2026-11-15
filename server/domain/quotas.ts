import type { Ctx } from './ctx';
import { DomainError } from './errors';

/** §8.7 MVP defaults, per org. `organizations.quota` (jsonb) may override any known key with a positive number. */
export const QUOTA_DEFAULTS = {
  max_projects: 50,
  max_file_bytes: 200 * 1024 * 1024,
  max_revision_bytes: 1024 ** 3,
  max_storage_bytes: 20 * 1024 ** 3,
  max_cases_per_set: 500,
  max_generations_per_day: 50,
} as const;
export type QuotaName = keyof typeof QUOTA_DEFAULTS;

/**
 * Not enforced here, by design: concurrent jobs (4, 1 analysis) is a claim-time limit for the worker, and the 2 GiB export size is only known after the
 * export job builds the package. Quotas are checked at API-facing entry points, never inside enqueue() or worker code, so a worker-side enqueue can never turn a 429 into a job failure.
 */
export async function effectiveQuota(c: Pick<Ctx, 'db' | 'orgId'>): Promise<Record<QuotaName, number>> {
  const row = (await c.db.query<{ quota: Record<string, unknown> | null }>('SELECT quota FROM organizations WHERE id=$1', [c.orgId]))[0];
  const out: Record<QuotaName, number> = { ...QUOTA_DEFAULTS };
  for (const k of Object.keys(QUOTA_DEFAULTS) as QuotaName[]) {
    const v = row?.quota?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export function quotaExceeded(name: QuotaName, limit: number, current: number, message: string) {
  return new DomainError('quota_exceeded', 429, message, { kind: 'quota', name, limit, current });
}

export async function assertProjectQuota(c: Ctx) {
  const q = await effectiveQuota(c);
  const n = (await c.db.query<{ n: number }>('SELECT count(*)::int AS n FROM projects WHERE org_id=$1 AND deleted_at IS NULL', [c.orgId]))[0].n;
  if (n >= q.max_projects) throw quotaExceeded('max_projects', q.max_projects, n, `Project limit reached (${q.max_projects}). Delete a project or ask an admin to raise the limit.`);
}

/** Per-file size and total org storage (stored blobs plus uploads still pending or received). */
export async function assertUploadQuota(c: Ctx, size: number) {
  const q = await effectiveQuota(c);
  if (size > q.max_file_bytes) throw quotaExceeded('max_file_bytes', q.max_file_bytes, size, `File exceeds ${Math.round(q.max_file_bytes / 1048576)} MiB`);
  const stored = Number((await c.db.query<{ n: string }>('SELECT COALESCE(sum(size_bytes),0)::text AS n FROM blobs WHERE org_id=$1', [c.orgId]))[0].n);
  const pending = Number((await c.db.query<{ n: string }>("SELECT COALESCE(sum(declared_size),0)::text AS n FROM upload_sessions WHERE org_id=$1 AND status IN ('pending','received') AND expires_at > now()", [c.orgId]))[0].n);
  if (stored + pending + size > q.max_storage_bytes) throw quotaExceeded('max_storage_bytes', q.max_storage_bytes, stored + pending, 'Organization storage limit reached.');
}

export async function assertRevisionQuota(c: Ctx, totalBytes: number) {
  const q = await effectiveQuota(c);
  if (totalBytes > q.max_revision_bytes) throw quotaExceeded('max_revision_bytes', q.max_revision_bytes, totalBytes, `Revision exceeds ${Math.round(q.max_revision_bytes / 1048576)} MiB`);
}

export async function assertGenerationQuota(c: Ctx) {
  const q = await effectiveQuota(c);
  const n = (await c.db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE org_id=$1 AND type='generation.requested' AND created_at > now() - interval '1 day'", [c.orgId]))[0].n;
  if (n >= q.max_generations_per_day) throw quotaExceeded('max_generations_per_day', q.max_generations_per_day, n, `Daily generation limit reached (${q.max_generations_per_day}).`);
}
