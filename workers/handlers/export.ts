import type { Job } from '../../server/jobs/queue';
import { buildExport } from '../export/build';
import type { JobControl, WorkerEnv } from '../runtime';

export async function exportHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const p = job.payload as { export_id: string; include_original_binary: boolean };
  await ctl.checkpoint({ phase: 'assembling' });
  const row = (await env.db.query<{ created_at: string }>('SELECT created_at FROM export_packages WHERE id=$1 AND org_id=$2', [p.export_id, job.org_id]))[0];
  const built = await buildExport({ db: env.db, store: env.store, orgId: job.org_id, exportId: p.export_id, createdAt: new Date(row.created_at).toISOString(), repoRoot: process.cwd(), includeOriginal: p.include_original_binary });
  const blob = await env.store.put(job.org_id, built.zip);
  await env.db.query('INSERT INTO blobs(org_id,sha256,size_bytes,storage_key,media_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [job.org_id, blob.sha256, blob.size, blob.key, 'application/zip']);
  await env.db.query('UPDATE export_packages SET manifest=$3, manifest_sha256=$4, sums_sha256=$5, package_blob_sha256=$6 WHERE id=$1 AND org_id=$2', [p.export_id, job.org_id, JSON.stringify(built.manifest), built.manifestSha, built.sumsSha, blob.sha256]);
  await env.db.query(`INSERT INTO events(org_id,project_id,type,subject_type,subject_id) VALUES ($1,$2,'export.ready','export',$3)`, [job.org_id, job.project_id, p.export_id]);
}
