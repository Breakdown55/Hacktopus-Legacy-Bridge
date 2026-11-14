import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseInput, Observation } from '@lb/contracts';
import type { ObservationData } from '@lb/compare';
import type { BlobStore } from '../../server/storage/blobstore';
import type { Db } from '../../server/db/db';
import type { CaseRun } from '../execution/runners';
import type { RunOutcome } from '../execution/harness';
import { writeTree, type WorkerEnv } from '../runtime';
import { putBlob } from '../../server/storage/blobs';

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function jobDir(env: WorkerEnv, jobId: string) { const d = join(env.workRoot, jobId); mkdirSync(d, { recursive: true }); return d; }
export const tmpIn = (dir: string, prefix: string) => mkdtempSync(join(dir, prefix));

export async function toCaseRun(store: BlobStore, orgId: string, input: CaseInput): Promise<CaseRun> {
  return {
    argv: input.argv, caseEnv: input.env, timeoutMs: input.timeout_ms,
    stdin: input.stdin_blob ? await store.get(orgId, input.stdin_blob) : Buffer.alloc(0),
    files: await Promise.all(input.files.map(async (f) => ({ path: f.path, content: await store.get(orgId, f.blob), mode: f.mode }))),
  };
}

/** Persists an outcome's bytes as blobs and returns the observation with blob references. */
export async function storeObservation(db: Db, store: BlobStore, orgId: string, o: RunOutcome): Promise<Observation> {
  const obs = structuredClone(o.data.observation);
  obs.stdout.blob = (await putBlob(db, store, orgId, o.data.stdout)).sha256;
  obs.stderr.blob = (await putBlob(db, store, orgId, o.data.stderr)).sha256;
  for (const f of obs.files) if (o.data.files[f.path]) f.blob = (await putBlob(db, store, orgId, o.data.files[f.path])).sha256;
  return obs;
}

export async function loadObservation(store: BlobStore, orgId: string, obs: Observation, extra: { deterministic?: boolean | null; variance?: { channels?: string[] } | null } = {}): Promise<ObservationData> {
  const get = async (b?: string) => (b ? store.get(orgId, b) : Buffer.alloc(0));
  const files: Record<string, Buffer> = {};
  for (const f of obs.files) if (f.blob) files[f.path] = await store.get(orgId, f.blob);
  return { observation: obs, stdout: await get(obs.stdout.blob), stderr: await get(obs.stderr.blob), files, deterministic: extra.deterministic ?? undefined, varied_channels: extra.variance?.channels };
}

/** Stage a source revision's primary executable (+ shared libraries) into dir. */
export async function stageSource(db: Db, store: BlobStore, orgId: string, sourceId: string, dir: string) {
  const arts = await db.query<{ path: string; role: string; blob_sha256: string }>('SELECT path, role, blob_sha256 FROM source_artifacts WHERE source_revision_id=$1 AND org_id=$2', [sourceId, orgId]);
  const primary = arts.find((a) => a.role === 'primary_executable');
  if (!primary) throw new Error('no primary executable');
  const libs = arts.filter((a) => a.role === 'shared_library');
  const files: { path: string; content: Buffer }[] = [{ path: `bin/${primary.path.split('/').pop()}`, content: await store.get(orgId, primary.blob_sha256) }];
  for (const l of libs) files.push({ path: `lib/${l.path.split('/').pop()}`, content: await store.get(orgId, l.blob_sha256) });
  writeTree(dir, files);
  const { chmodSync } = await import('node:fs');
  chmodSync(join(dir, files[0].path), 0o755);
  return { binaryRel: files[0].path, hasLibs: libs.length > 0, primarySha: primary.blob_sha256, primaryPath: primary.path };
}

/** Channels whose bytes/exit differ between two complete observations (nondeterminism detection). */
export function variedChannels(a: RunOutcome, b: RunOutcome): string[] {
  const out: string[] = [];
  const x = a.data.observation, y = b.data.observation;
  if (x.exit.code !== y.exit.code || x.exit.signal !== y.exit.signal) out.push('exit');
  if (x.stdout.sha256 !== y.stdout.sha256) out.push('stdout');
  if (x.stderr.sha256 !== y.stderr.sha256) out.push('stderr');
  if (JSON.stringify(x.files.map((f) => [f.path, f.status, f.sha256])) !== JSON.stringify(y.files.map((f) => [f.path, f.status, f.sha256]))) out.push('files');
  return out;
}
