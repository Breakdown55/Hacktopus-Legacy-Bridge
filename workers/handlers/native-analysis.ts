import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { persistNativeAnalysis } from '../../server/domain/analysis';
import type { Job } from '../../server/jobs/queue';
import { JobError, LeaseLostError, orgCtx, type JobControl, type WorkerEnv } from '../runtime';
import { sha } from './common';

export async function nativeAnalysisHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  if (!env.rea) throw new JobError('analysis_worker_unconfigured');
  const [primary] = await env.db.query<{ blob_sha256: string }>(`
    SELECT blob_sha256 FROM source_artifacts
    WHERE source_revision_id=$1 AND org_id=$2 AND role='primary_executable'
  `, [job.subject_id, job.org_id]);
  if (!primary) throw new JobError('primary_missing');

  const payload = job.payload as { address?: unknown };
  const address = job.kind === 'native_deep_function' ? payload?.address : undefined;
  if (job.kind === 'native_deep_function' && typeof address !== 'string') throw new JobError('invalid_function_address');
  await ctl.checkpoint({ phase: 'loading_artifact' });
  const bytes = await env.store.get(job.org_id, primary.blob_sha256);
  if (sha(bytes) !== primary.blob_sha256) throw new JobError('hash_mismatch');

  const root = resolve(env.workRoot);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'rea-'));
  const targetPath = join(directory, 'artifact');
  try {
    await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o444 });
    const result = await env.rea.analyze({
      targetPath, artifactSha256: primary.blob_sha256, address: typeof address === 'string' ? address : undefined,
      checkpoint: (progress) => ctl.checkpoint(progress),
    });
    await ctl.checkpoint({ phase: 'storing_evidence' });
    if (await persistNativeAnalysis(orgCtx(env, job), job, result, env.workerId)) return 'finalized' as const;
    await ctl.checkpoint();
    throw new LeaseLostError();
  } finally {
    // Docker only sees the one read-only file. Cleanup removes only paths this handler created.
    try {
      await rm(targetPath, { force: true });
      await rmdir(directory);
    } catch (error) {
      console.warn('[lb] analysis cleanup failed', (error as NodeJS.ErrnoException).code);
    }
  }
}
