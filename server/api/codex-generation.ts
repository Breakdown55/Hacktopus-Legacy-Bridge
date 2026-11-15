import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { remoteFailureSchema, remoteGenerationKind, remoteGenerationLimit, remoteResultSchema } from '../../workers/generation/remote-contract';
import { problem } from '../http/handler';
import { claim, finish, heartbeat, reap } from '../jobs/queue';
import { putBlob } from '../storage/blobs';
import { readBody, withCodexAccess } from './codex-jobs';

const lease = { id: z.uuid(), lease: z.uuid() };
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ ...lease, action: z.literal('heartbeat') }),
  z.object({ ...lease, action: z.literal('complete'), result: remoteResultSchema }),
  z.object({ ...lease, action: z.literal('fail'), error: remoteFailureSchema }),
]);

const owned = `j.id=$1 AND j.lease_owner=$2 AND j.org_id=$3 AND j.kind=$4
  AND j.status='running' AND j.lease_expires_at>now()`;
const parentActive = `EXISTS (
  SELECT 1 FROM jobs p
  JOIN projects project ON project.id=p.project_id AND project.org_id=p.org_id
  JOIN scope_revisions s ON s.id=p.subject_id AND s.org_id=p.org_id
  JOIN organizations o ON o.id=p.org_id
  WHERE p.id=j.subject_id AND p.org_id=j.org_id AND p.project_id=j.project_id AND p.kind='generate'
    AND p.status='running' AND p.cancel_requested_at IS NULL AND p.lease_expires_at>now()
    AND p.attempt=(j.payload->>'parentAttempt')::int AND project.deleted_at IS NULL
    AND project.approved_scope_revision_id=s.id AND project.current_source_revision_id=s.source_revision_id
    AND o.external_model_allowed
)`;
const lost = () => problem(409, 'lease_lost', 'Generation lease lost');
const noStore = { 'cache-control': 'no-store' };

export const generationWorkerCommand = (req: Request) => withCodexAccess(req, 'worker', async ({ db, store }, orgId) => {
  const body = await readBody(req, remoteGenerationLimit);
  let raw: unknown;
  try { raw = body && JSON.parse(body.toString('utf8')); } catch { /* invalid request */ }
  const parsed = command.safeParse(raw);
  if (!parsed.success) return problem(400, 'invalid_worker_command', 'Invalid generation command');
  const cmd = parsed.data;
  if (cmd.action === 'claim') {
    await reap(db, remoteGenerationKind, orgId);
    const owner = randomUUID();
    const job = await claim(db, owner, [remoteGenerationKind], orgId);
    if (!job) return Response.json(null, { headers: noStore });
    const active = await db.query(`SELECT 1 FROM jobs j WHERE ${owned} AND ${parentActive} AND j.cancel_requested_at IS NULL`,
      [job.id, owner, orgId, remoteGenerationKind]);
    if (!active.length) {
      await finish(db, job.id, owner, { status: 'cancelled' });
      return Response.json(null, { headers: noStore });
    }
    const input = await store.get(orgId, String(job.payload.input));
    return Response.json({ id: job.id, lease: owner, model: job.payload.model, request: JSON.parse(input.toString('utf8')) }, { headers: noStore });
  }
  const args = [cmd.id, cmd.lease, orgId, remoteGenerationKind];
  const [current] = await db.query<{ cancelled: boolean }>(
    `SELECT j.cancel_requested_at IS NOT NULL OR NOT ${parentActive} AS cancelled FROM jobs j WHERE ${owned}`, args);
  if (!current) return lost();
  if (current.cancelled) {
    await finish(db, cmd.id, cmd.lease, { status: 'cancelled' });
    return cmd.action === 'heartbeat' ? Response.json({ cancelRequested: true }, { headers: noStore }) : lost();
  }
  if (cmd.action === 'heartbeat') {
    const status = await heartbeat(db, cmd.id, cmd.lease);
    return status ? Response.json(status, { headers: noStore }) : lost();
  }
  const output = cmd.action === 'complete'
    ? await putBlob(db, store, orgId, Buffer.from(JSON.stringify(cmd.result)), 'application/json') : null;
  const updated = await db.query(
    `UPDATE jobs j SET status=$5, progress=$6::jsonb, error=$7::jsonb, finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
      WHERE ${owned} AND j.cancel_requested_at IS NULL AND ${parentActive} RETURNING id`,
    [...args, output ? 'succeeded' : 'failed', output ? JSON.stringify({ output: output.sha256 }) : null,
      cmd.action === 'fail' ? JSON.stringify({ code: cmd.error }) : null],
  );
  return updated.length ? new Response(null, { status: 204 }) : lost();
});
