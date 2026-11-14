/**
 * Worker process entry: node/tsx workers/run.ts
 * Wires Postgres, S3/MinIO and the runners, seeds platform environments, then claims jobs.
 */
import { mkdirSync } from 'node:fs';
import { createPgDb } from '../server/db/pg';
import { CONTROLS, ensureEnvironment } from '../server/domain/environments';
import { S3BlobStore } from '../server/storage/s3';
import { localBuild } from './build/local';
import { DockerOriginalRunner, DockerReplacementRunner } from './execution/runners';
import { NODE_IMAGE } from './export/build';
import { defaultWorkerId, workerLoop } from './main';
import type { WorkerEnv } from './runtime';

const ORIGINAL_IMAGE = process.env.LB_ORIGINAL_IMAGE ?? 'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';

async function main() {
  const { DATABASE_URL, S3_BUCKET } = process.env;
  if (!DATABASE_URL || !S3_BUCKET) throw new Error('DATABASE_URL and S3_BUCKET are required');
  // Original binaries and replacement runs always go through the hardened container runner.
  // Only the tsc build still runs on the host (tsc does not execute the input, but it is unsandboxed): it needs explicit opt-in.
  if (process.env.LB_SANDBOX !== 'direct' || process.env.NODE_ENV === 'production') {
    throw new Error('The build step is not sandboxed yet (slice S1 gap). Set LB_SANDBOX=direct for non-production development only.');
  }
  console.warn('[lb] WARNING: tsc builds run on the host WITHOUT isolation (LB_SANDBOX=direct). Development only.');
  const db = createPgDb();
  const store = new S3BlobStore(S3_BUCKET, { endpoint: process.env.S3_ENDPOINT || undefined, region: process.env.S3_REGION });
  await ensureEnvironment(db, { name: 'original-glibc', version: 1, role: 'original', image_digest: ORIGINAL_IMAGE, arch: 'x86-64', controls: CONTROLS });
  await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: NODE_IMAGE, arch: process.arch, controls: CONTROLS });
  const workRoot = process.env.LB_WORK_ROOT ?? '/var/lib/lb/jobs';
  mkdirSync(workRoot, { recursive: true });
  const env: WorkerEnv = { db, store, workRoot, workerId: defaultWorkerId(), original: new DockerOriginalRunner({ runtime: process.env.LB_RUNTIME || undefined }), replacement: new DockerReplacementRunner(NODE_IMAGE, { runtime: process.env.LB_RUNTIME || undefined }), build: (f) => localBuild(f) };
  let stop = false;
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
  console.log(`[lb] worker ${env.workerId} started`);
  await workerLoop(env, { stop: () => stop });
  await db.close();
}
main().catch((e) => { console.error('[lb] worker failed:', (e as Error).message); process.exit(1); });
