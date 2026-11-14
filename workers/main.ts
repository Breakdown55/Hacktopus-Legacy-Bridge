import { hostname } from 'node:os';
import type { Db } from '../server/db/db';
import { claim, finish, reap, retryOrFail, type Job } from '../server/jobs/queue';
import { CancelledError, JobError, LeaseLostError, RetryableError, controlFor, type JobHandler, type WorkerEnv } from './runtime';
import { buildHandler } from './handlers/build';
import { captureHandler } from './handlers/capture';
import { inspectHandler } from './handlers/inspect';
import { probeHandler } from './handlers/probe';
import { verifyHandler } from './handlers/verify';
import { exportHandler } from './handlers/export';

export const HANDLERS: Record<string, JobHandler> = { inspect: inspectHandler, probe: probeHandler, build: buildHandler, capture: captureHandler, verify: verifyHandler, export: exportHandler };

/** Runs one claimed job to a terminal or requeued state. Returns what happened. */
export async function runJob(env: WorkerEnv, job: Job): Promise<string> {
  const handler = HANDLERS[job.kind];
  if (!handler) { await finish(env.db, job.id, env.workerId, { status: 'failed', error: { code: 'unknown_kind', kind: job.kind } }); return 'failed'; }
  const timer = setInterval(() => { void controlFor(env, job).checkpoint().catch(() => {}); }, 10_000);
  try {
    await handler(env, job, controlFor(env, job));
    return (await finish(env.db, job.id, env.workerId, { status: 'succeeded' })) ? 'succeeded' : 'lost';
  } catch (e) {
    if (e instanceof LeaseLostError) return 'lost'; // another worker owns it; our writes were idempotent no-ops
    if (e instanceof CancelledError) { await finish(env.db, job.id, env.workerId, { status: 'cancelled' }); return 'cancelled'; }
    // Errors carry codes only; program output and artifact content never go into job errors or logs (§8.4).
    if (e instanceof JobError) { await finish(env.db, job.id, env.workerId, { status: 'failed', error: { code: e.code } }); return 'failed'; }
    const retryable = e instanceof RetryableError || /ECONN|ETIMEDOUT|EAI_AGAIN|\bHTTP 5\d\d\b/.test(String((e as Error).message));
    if (retryable) return retryOrFail(env.db, job.id, env.workerId, { code: 'transient', message: String((e as Error).message).slice(0, 200) });
    await finish(env.db, job.id, env.workerId, { status: 'failed', error: { code: 'internal_error', message: String((e as Error).message).slice(0, 200) } });
    return 'failed';
  } finally { clearInterval(timer); }
}

/** Claims and runs jobs until `stop()` returns true. Also reaps expired leases. */
export async function workerLoop(env: WorkerEnv, opts: { kinds?: string[]; idleMs?: number; stop?: () => boolean } = {}) {
  let lastReap = 0;
  while (!opts.stop?.()) {
    if (Date.now() - lastReap > 15_000) { await reap(env.db); lastReap = Date.now(); }
    const job = await claim(env.db, env.workerId, opts.kinds);
    if (!job) { await new Promise((r) => setTimeout(r, opts.idleMs ?? 500)); continue; }
    await runJob(env, job);
  }
}

/** Drains the queue once (tests): runs every currently-claimable job. Returns the number run. */
export async function drain(env: WorkerEnv, kinds?: string[]): Promise<number> {
  let n = 0;
  for (let job = await claim(env.db, env.workerId, kinds); job; job = await claim(env.db, env.workerId, kinds)) { await runJob(env, job); n++; }
  return n;
}

export const defaultWorkerId = () => `${hostname()}:${process.pid}`;
export type { Db };
