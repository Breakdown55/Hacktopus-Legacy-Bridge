import type { Db } from '../db/db';
import type { BlobStore } from '../storage/blobstore';

/**
 * Retention and purge (plan §3.10, §8.4). Framework-independent.
 *
 * A project is purged GRACE_DAYS after it was soft-deleted (`projects.deleted_at`). The purge runs in ONE transaction as role `lb_purge`
 * (the only role the immutability triggers admit), removes the project's rows in FK-safe order, reduces its audit events to ids,
 * then removes blobs that no remaining row in the org references. Object-store deletes happen AFTER the commit: the database is the
 * source of truth, and a failed store delete only leaves an unreferenced object, so failures are reported in `orphaned_keys`
 * (the next pass cannot rediscover them) instead of being silently dropped.
 *
 * Blob reachability is computed generically: a blob is referenced if its sha256 appears anywhere in a remaining row of any org-scoped
 * table (columns, JSON documents, manifests, transcripts, raw evidence). That can only over-retain (a digest that is not a blob
 * reference keeps nothing alive but a blob), never delete something still in use, and it needs no per-column list to keep current.
 */
export const GRACE_DAYS = 7;
export const STAGING_HOURS = 24;

export interface PurgeOptions { orgId?: string; graceDays?: number; stagingHours?: number; now?: Date }
export interface PurgeReport {
  projects_purged: string[];
  blobs_deleted: number;
  staging_deleted: number;
  export_zips_deleted: number;
  /** Object-store keys whose delete failed after the database commit. Their blob rows are gone, so they are not rediscovered: sweep the bucket. */
  orphaned_keys: string[];
}

const ROLE = 'lb_purge';
// Child tables first. Each statement removes one table's rows for ($1 org, $2 project).
const PROJECT_DELETES: string[] = [
  'DELETE FROM verification_results WHERE org_id=$1::uuid AND verification_run_id IN (SELECT id FROM verification_runs WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM export_packages WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM verification_runs WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM build_results WHERE org_id=$1::uuid AND module_revision_id IN (SELECT id FROM module_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM module_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM approvals WHERE org_id=$1::uuid AND scope_revision_id IN (SELECT id FROM scope_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM scope_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM scope_drafts WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM findings WHERE org_id=$1::uuid AND source_revision_id IN (SELECT id FROM source_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM analysis_runs WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM reference_outputs WHERE org_id=$1::uuid AND test_case_id IN (SELECT id FROM test_cases WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM test_cases WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM case_set_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM comparison_policies WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM source_artifacts WHERE org_id=$1::uuid AND source_revision_id IN (SELECT id FROM source_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid)',
  'DELETE FROM source_revisions WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM upload_sessions WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM jobs WHERE org_id=$1::uuid AND project_id=$2::uuid',
  'DELETE FROM projects WHERE org_id=$1::uuid AND id=$2::uuid',
];

/** Every sha256 mentioned by any remaining row of an org-scoped table (except the blob index itself and idempotency replays). */
export async function referencedBlobs(db: Db, orgId: string): Promise<Set<string>> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='org_id' AND table_name NOT IN ('blobs','idempotency_keys','memberships') GROUP BY table_name ORDER BY table_name`);
  const found = new Set<string>();
  for (const { table_name } of tables) {
    const rows = await db.query<{ sha: string }>(`SELECT DISTINCT m[1] AS sha FROM "${table_name}" x, regexp_matches(row_to_json(x)::text, '([0-9a-f]{64})', 'g') AS m WHERE x.org_id=$1::uuid`, [orgId]);
    for (const r of rows) found.add(r.sha);
  }
  return found;
}

async function requirePurgeRole(db: Db) {
  const r = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ROLE]);
  if (!r.length) throw new Error(`purge_role_missing: database role ${ROLE} does not exist (created by the S7 roles migration)`);
}

/** Deletes object-store keys, collecting failures. Idempotent. */
export async function deleteBlobs(store: BlobStore, orgId: string, shas: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const sha of shas) { try { await store.delete(orgId, sha); } catch { failed.push(`${orgId}/${sha}`); } }
  return failed;
}

/** Purges one soft-deleted project and the blobs only it used. Caller decides eligibility (see purgeExpired). */
export async function purgeProject(db: Db, store: BlobStore, orgId: string, projectId: string): Promise<{ blobs: string[]; orphaned: string[] } | null> {
  await requirePurgeRole(db);
  const blobs = await db.tx(async (t) => {
    await t.query(`SET LOCAL ROLE ${ROLE}`);
    const still = await t.query('SELECT 1 FROM projects WHERE id=$1::uuid AND org_id=$2::uuid AND deleted_at IS NOT NULL', [projectId, orgId]);
    if (!still.length) return null; // not a tombstone (restored, or already purged)
    const before = await referencedBlobs(t, orgId);
    for (const sql of PROJECT_DELETES) await t.query(sql, [orgId, projectId]);
    // Audit rows stay, reduced to ids: the customer data that rode along in `data` is gone. This is DELETE + INSERT with the same id and
    // timestamp, not UPDATE: migration 0001's lb_reject_mutation() returns OLD for lb_purge, which turns a BEFORE UPDATE into a silent no-op.
    await t.query(`WITH old AS (DELETE FROM events WHERE org_id=$1::uuid AND project_id=$2::uuid RETURNING *)
      INSERT INTO events(id,org_id,project_id,actor_id,type,subject_type,subject_id,data,created_at)
      SELECT id, org_id, project_id, actor_id, type, subject_type, subject_id,
             COALESCE((SELECT jsonb_object_agg(k, v) FROM jsonb_each(old.data) AS e(k, v) WHERE k ~ '(^|_)id$'), '{}'::jsonb), created_at FROM old`, [orgId, projectId]);
    await t.query(`INSERT INTO events(org_id,project_id,type,subject_type,subject_id) VALUES ($1::uuid,$2::uuid,'project.purged','project',$2::uuid::text)`, [orgId, projectId]);
    const after = await referencedBlobs(t, orgId);
    const orphaned = [...before].filter((sha) => !after.has(sha));
    if (!orphaned.length) return [];
    const exist = await t.query<{ sha256: string }>('SELECT sha256 FROM blobs WHERE org_id=$1::uuid AND sha256 = ANY($2::text[])', [orgId, orphaned]);
    const gone = exist.map((r) => r.sha256);
    if (gone.length) await t.query('DELETE FROM blobs WHERE org_id=$1::uuid AND sha256 = ANY($2::text[])', [orgId, gone]);
    return gone;
  });
  if (blobs === null) return null;
  return { blobs, orphaned: await deleteBlobs(store, orgId, blobs) };
}

/** One retention pass. Safe to run repeatedly and concurrently with API traffic; a second run finds nothing to do. */
export async function purgeExpired(db: Db, store: BlobStore, o: PurgeOptions = {}): Promise<PurgeReport> {
  const now = o.now ?? new Date();
  const grace = new Date(now.getTime() - (o.graceDays ?? GRACE_DAYS) * 86_400_000);
  const stagingCut = new Date(now.getTime() - (o.stagingHours ?? STAGING_HOURS) * 3_600_000);
  const report: PurgeReport = { projects_purged: [], blobs_deleted: 0, staging_deleted: 0, export_zips_deleted: 0, orphaned_keys: [] };

  const projects = await db.query<{ id: string; org_id: string }>(
    'SELECT id, org_id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < $1 AND ($2::uuid IS NULL OR org_id = $2::uuid) ORDER BY deleted_at, id', [grace, o.orgId ?? null]);
  for (const p of projects) {
    const r = await purgeProject(db, store, p.org_id, p.id);
    if (!r) continue;
    report.projects_purged.push(p.id);
    report.blobs_deleted += r.blobs.length;
    report.orphaned_keys.push(...r.orphaned);
  }

  // Staging uploads that never completed: the object (if any) goes after 24 h.
  const staged = await db.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM upload_sessions WHERE status IN ('pending','received','rejected') AND created_at < $1 AND ($2::uuid IS NULL OR org_id = $2::uuid)`, [stagingCut, o.orgId ?? null]);
  for (const u of staged) {
    try { await store.deleteStaged(u.org_id, u.id); } catch { report.orphaned_keys.push(`${u.org_id}/staging/${u.id}`); continue; }
    await db.query("UPDATE upload_sessions SET status='expired' WHERE id=$1::uuid AND org_id=$2::uuid", [u.id, u.org_id]);
    report.staging_deleted++;
  }

  // Expired export zips: the blob goes, the manifest row stays (getExport reports it as expired; the zip can be rebuilt from the binding).
  const zips = await db.query<{ org_id: string; sha: string }>(
    `SELECT DISTINCT e.org_id, e.package_blob_sha256 AS sha FROM export_packages e
     WHERE e.package_blob_sha256 IS NOT NULL AND e.expires_at < $1 AND ($2::uuid IS NULL OR e.org_id = $2::uuid)
       AND EXISTS (SELECT 1 FROM blobs b WHERE b.org_id=e.org_id AND b.sha256=e.package_blob_sha256)
       AND NOT EXISTS (SELECT 1 FROM export_packages x WHERE x.org_id=e.org_id AND x.package_blob_sha256=e.package_blob_sha256 AND x.expires_at >= $1)`, [now, o.orgId ?? null]);
  for (const z of zips) {
    await db.query('DELETE FROM blobs WHERE org_id=$1::uuid AND sha256=$2', [z.org_id, z.sha]);
    const failed = await deleteBlobs(store, z.org_id, [z.sha]);
    if (failed.length) report.orphaned_keys.push(...failed); else report.export_zips_deleted++;
  }
  return report;
}
