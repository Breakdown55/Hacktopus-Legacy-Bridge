import { uuidv7 } from '../db/ids';
import { enqueue } from '../jobs/queue';
import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { getHeads } from './projects';
import { appliesToCurrent } from './verification';

/** Exports are produced only from a finalized verification run (invariant 13). */
export async function createExport(c: Ctx, projectId: string, i: { verification_run_id: string; include_original_binary?: boolean; allow_partial?: boolean }) {
  await getHeads(c.db, c.orgId, projectId);
  const r = (await c.db.query<{ completeness: string | null; binding_digest: string }>('SELECT completeness, binding_digest FROM verification_runs WHERE id=$1 AND org_id=$2 AND project_id=$3', [i.verification_run_id, c.orgId, projectId]))[0];
  if (!r) throw new DomainError('not_found', 404);
  if (!r.completeness) throw new DomainError('run_not_finished', 409, 'The verification run has not finished.');
  if (r.completeness === 'partial' && !i.allow_partial) throw new DomainError('partial_run', 409, 'The verification run is partial. Pass allow_partial to export it; the manifest will record that.', { kind: 'allow_partial' });
  const id = uuidv7();
  return c.db.tx(async (t) => {
    const job = await enqueue(t, { orgId: c.orgId, projectId, kind: 'export', subjectType: 'export', subjectId: id, payload: { export_id: id, include_original_binary: !!i.include_original_binary, allow_partial: !!i.allow_partial }, dedupeKey: `export:${id}` });
    await t.query(`INSERT INTO export_packages(id,org_id,project_id,verification_run_id,binding_digest,job_id,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '30 days')`, [id, c.orgId, projectId, i.verification_run_id, r.binding_digest, job.id, c.userId]);
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'export.created','export',$4)`, [c.orgId, projectId, c.userId, id]);
    return { export_id: id, job_id: job.id };
  });
}

export async function getExport(c: Ctx, exportId: string) {
  const e = (await c.db.query<{ id: string; project_id: string; verification_run_id: string; job_id: string; manifest_sha256: string | null; sums_sha256: string | null; package_blob_sha256: string | null; expires_at: string }>('SELECT id, project_id, verification_run_id, job_id, manifest_sha256, sums_sha256, package_blob_sha256, expires_at FROM export_packages WHERE id=$1 AND org_id=$2', [exportId, c.orgId]))[0];
  if (!e) throw new DomainError('not_found', 404);
  const job = (await c.db.query<{ status: string; error: unknown }>('SELECT status, error FROM jobs WHERE id=$1', [e.job_id]))[0];
  const ready = !!e.package_blob_sha256;
  const expired = ready && new Date(e.expires_at) < new Date();
  // Computed on read, never stored and never part of the package: it changes whenever the project's heads move.
  const applies = await appliesToCurrent(c.db, c.orgId, e.project_id, e.verification_run_id);
  return { id: e.id, status: expired ? 'expired' : ready ? 'ready' : job.status === 'failed' ? 'failed' : 'building', manifest_sha256: e.manifest_sha256, sums_sha256: e.sums_sha256, download_url: ready && !expired ? `/api/v1/exports/${e.id}/download` : null, expires_at: e.expires_at, applies_to_current: applies?.applies_to_current ?? null, stale_reasons: applies?.stale_reasons ?? [], error: job.error };
}
