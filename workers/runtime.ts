import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../server/db/db';
import type { Job } from '../server/jobs/queue';
import { heartbeat } from '../server/jobs/queue';
import type { BlobStore } from '../server/storage/blobstore';
import type { Ctx } from '../server/domain/ctx';
import type { BuildOutput } from './build/local';
import type { OriginalRunner, ReplacementRunner } from './execution/runners';
import type { ReaAnalysisRunner } from './analysis/rea/runner';

export interface WorkerEnv {
  db: Db; store: BlobStore; workRoot: string; workerId: string;
  original: OriginalRunner; replacement: ReplacementRunner;
  rea?: ReaAnalysisRunner;
  build: (files: { path: string; content: Buffer }[]) => Promise<BuildOutput>;
}
export class CancelledError extends Error { constructor() { super('cancelled'); } }
export class LeaseLostError extends Error { constructor() { super('lease lost'); } }
/** Transient (storage 5xx, sandbox start failure...). The job is requeued with backoff. */
export class RetryableError extends Error {}
/** Permanent failure with a problem-style code. */
export class JobError extends Error { constructor(public code: string, message?: string) { super(message ?? code); } }

export interface JobControl {
  /** Heartbeats and records progress; throws CancelledError / LeaseLostError so the handler stops. */
  checkpoint(progress?: unknown): Promise<void>;
}
export type JobHandler = (env: WorkerEnv, job: Job, ctl: JobControl) => Promise<void | 'finalized'>;

export const orgCtx = (env: WorkerEnv, job: Job, userId: string | null = null): Ctx => ({ db: env.db, store: env.store, orgId: job.org_id, userId });

export function controlFor(env: WorkerEnv, job: Job): JobControl {
  return {
    async checkpoint(progress) {
      const hb = await heartbeat(env.db, job.id, env.workerId, progress);
      if (!hb) throw new LeaseLostError();
      if (hb.cancelRequested) throw new CancelledError();
    },
  };
}

/** Writes blobs to a directory tree under workdir. Paths are validated by callers. */
export function writeTree(root: string, files: { path: string; content: Buffer }[]) {
  for (const f of files) { const p = join(root, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
}
