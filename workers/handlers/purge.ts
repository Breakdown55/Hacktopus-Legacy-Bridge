import type { Job } from '../../server/jobs/queue';
import { purgeExpired } from '../../server/domain/purge';
import type { JobControl, WorkerEnv } from '../runtime';

/**
 * Job kind `purge`: one retention pass for the job's org. Not registered in HANDLERS yet; register it in workers/main.ts and enqueue it
 * periodically (for example an hourly `enqueue(db, { orgId, kind: 'purge', dedupeKey: 'purge' })` from the worker loop or a scheduler).
 * The report carries ids and counts only: no customer content.
 */
export async function purgeHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  await ctl.checkpoint({ phase: 'purging' });
  const report = await purgeExpired(env.db, env.store, { orgId: job.org_id });
  // The database side is committed and idempotent. Object deletes that failed leave unreferenced objects the next pass cannot rediscover
  // (their blob rows are gone), so record the count as an audit event for the operator's bucket sweep. Keys are not logged.
  if (report.orphaned_keys.length) await env.db.query(`INSERT INTO events(org_id,type,data) VALUES ($1::uuid,'purge.orphaned_objects',$2)`, [job.org_id, JSON.stringify({ count: report.orphaned_keys.length })]);
  await ctl.checkpoint({ phase: 'done', projects: report.projects_purged.length, blobs: report.blobs_deleted });
}
