import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MAX_ANALYSIS_BYTES, type AnalysisStatus } from '../../lib/codex-analysis';
import { getApp } from '../app';
import { problem } from '../http/handler';
import { claim, enqueue, heartbeat, reap } from '../jobs/queue';
import { putBlob } from '../storage/blobs';

const KIND = 'codex.inspect';
const uuid = z.uuid();
const resultSchema = z.object({
  summary: z.string().min(1).max(4000),
  candidates: z.array(z.object({ name: z.string().min(1).max(70), evidence: z.string().min(1).max(600) })).max(12),
  limitations: z.array(z.string().min(1).max(400)).max(12),
});
const failureSchema = z.enum(['artifact_download_failed', 'rea_failed', 'codex_failed', 'invalid_result']);
const claimSchema = z.object({ action: z.literal('claim') });
const lease = { id: uuid, lease: uuid };
const command = z.discriminatedUnion('action', [
  claimSchema, z.object({ ...lease, action: z.literal('artifact') }),
  z.object({ ...lease, action: z.literal('heartbeat') }),
  z.object({ ...lease, action: z.literal('complete'), result: resultSchema }),
  z.object({ ...lease, action: z.literal('fail'), error: failureSchema }),
]);

function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

async function handle(req: Request, audience: 'user' | 'worker', fn: (app: Awaited<ReturnType<typeof getApp>>, orgId: string) => Promise<Response>) {
  const orgId = uuid.safeParse(process.env.LB_CODEX_ORG_ID);
  const userKey = process.env.LB_CODEX_DEMO_KEY;
  const workerKey = process.env.LB_CODEX_WORKER_KEY;
  if (!orgId.success || !userKey || !workerKey || userKey.length < 32 || workerKey.length < 32 || equal(userKey, workerKey)) {
    return problem(503, 'codex_worker_disabled', 'Remote analysis is not configured');
  }
  const key = audience === 'worker' ? workerKey : userKey;
  if (!equal(req.headers.get('authorization') ?? '', 'Bearer ' + key)) {
    return problem(401, 'unauthenticated', 'Invalid analysis access key');
  }
  try {
    const app = await getApp();
    const [org] = await app.db.query('SELECT id FROM organizations WHERE id=$1 AND external_model_allowed', [orgId.data]);
    if (!org) return problem(403, 'external_model_disabled', 'External model analysis is disabled');
    return await fn(app, orgId.data);
  } catch {
    return problem(500, 'analysis_unavailable', 'Analysis service unavailable');
  }
}

async function readBody(req: Request, limit: number): Promise<Buffer | null> {
  if (Number(req.headers.get('content-length')) > limit || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

export const submitAnalysis = (req: Request) => handle(req, 'user', async ({ db, store }, orgId) => {
  let context: string;
  try { context = decodeURIComponent(req.headers.get('x-lb-context') ?? ''); }
  catch { return problem(400, 'invalid_context', 'Invalid analysis context'); }
  if (context.length > 1000) return problem(400, 'invalid_context', 'Analysis context is limited to 1,000 characters');
  const bytes = await readBody(req, MAX_ANALYSIS_BYTES);
  if (!bytes) return problem(413, 'artifact_too_large', 'Executable must be at most 16 MiB');
  const format = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ? 'elf'
    : bytes.subarray(0, 2).equals(Buffer.from('MZ')) ? 'exe' : null;
  if (!format) return problem(422, 'unsupported_artifact', 'Choose a Windows PE or Linux ELF executable');

  const blob = await putBlob(db, store, orgId, bytes);
  const scope = createHash('sha256').update(context).digest('hex');
  const job = await enqueue(db, {
    orgId, kind: KIND, payload: { sha256: blob.sha256, format, context },
    dedupeKey: KIND + ':' + blob.sha256 + ':' + scope, maxAttempts: 2,
  });
  return Response.json({ id: job.id }, { status: 202 });
});

export const analysisStatus = (req: Request) => handle(req, 'user', async ({ db }, orgId) => {
  const id = uuid.safeParse(new URL(req.url).searchParams.get('id'));
  if (!id.success) return problem(404, 'not_found', 'Analysis job not found');
  await reap(db, KIND, orgId);
  const [job] = await db.query<{ status: AnalysisStatus['status']; progress: AnalysisStatus['result']; error: { code?: string } | null }>(
    'SELECT status, progress, error FROM jobs WHERE id=$1 AND org_id=$2 AND kind=$3', [id.data, orgId, KIND],
  );
  if (!job) return problem(404, 'not_found', 'Analysis job not found');
  return Response.json({
    status: job.status, result: job.status === 'succeeded' ? job.progress : undefined, error: job.error?.code,
  } satisfies AnalysisStatus, { headers: { 'cache-control': 'no-store' } });
});

export const workerCommand = (req: Request) => handle(req, 'worker', async ({ db, store }, orgId) => {
  const data = await readBody(req, 96 * 1024);
  let raw: unknown;
  try { raw = data && JSON.parse(data.toString()); } catch { /* invalid request */ }
  const parsed = command.safeParse(raw);
  if (!parsed.success) return problem(400, 'invalid_worker_command', 'Invalid worker command');
  const cmd = parsed.data;
  if (cmd.action === 'claim') {
    await reap(db, KIND, orgId);
    const lease = randomUUID();
    const job = await claim(db, lease, [KIND], orgId);
    return Response.json(job ? { id: job.id, lease, ...job.payload } : null);
  }

  const [job] = await db.query<{ payload: { sha256: string }; cancel_requested_at: string | null }>(
    "SELECT payload,cancel_requested_at FROM jobs WHERE id=$1 AND lease_owner=$2 AND org_id=$3 AND kind=$4 AND status='running' AND lease_expires_at > now()",
    [cmd.id, cmd.lease, orgId, KIND],
  );
  if (!job) return problem(409, 'lease_lost', 'Job lease lost');
  if (cmd.action === 'heartbeat') {
    const alive = await heartbeat(db, cmd.id, cmd.lease);
    return alive ? Response.json(alive) : problem(409, 'lease_lost', 'Job lease lost');
  }
  if (cmd.action === 'artifact') {
    if (job.cancel_requested_at) return problem(409, 'cancel_requested', 'Job cancellation requested');
    const bytes = await store.get(orgId, job.payload.sha256);
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  // Store the result and finish the lease in one write. A stale worker cannot publish.
  const updated = await db.query(
    `UPDATE jobs SET status=CASE WHEN cancel_requested_at IS NULL THEN $5 ELSE 'cancelled' END,
        progress=CASE WHEN cancel_requested_at IS NULL THEN $6::jsonb ELSE NULL END,
        error=CASE WHEN cancel_requested_at IS NULL THEN $7::jsonb ELSE NULL END,
        finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2 AND org_id=$3 AND kind=$4 AND status='running' AND lease_expires_at > now() RETURNING id`,
    [cmd.id, cmd.lease, orgId, KIND, cmd.action === 'complete' ? 'succeeded' : 'failed',
      cmd.action === 'complete' ? JSON.stringify(cmd.result) : null,
      cmd.action === 'fail' ? JSON.stringify({ code: cmd.error }) : null],
  );
  return updated.length ? new Response(null, { status: 204 }) : problem(409, 'lease_lost', 'Job lease lost');
});
