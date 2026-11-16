import { setTimeout as sleep } from 'node:timers/promises';
import type { Db } from '../../server/db/db';
import { cancel, enqueue } from '../../server/jobs/queue';
import type { BlobStore } from '../../server/storage/blobstore';
import { putBlob } from '../../server/storage/blobs';
import { JobError, RetryableError } from '../runtime';
import type { CodeGenerator } from './provider';
import { remoteFailureSchema, remoteGenerationKind, remoteGenerationLimit, remoteResultSchema } from './remote-contract';

/** Host-side adapter. The processing laptop claims the prompt and returns structured files through HTTPS. */
export class RemoteCodexGenerator implements CodeGenerator {
  constructor(private readonly options: { db: Db; store: BlobStore; orgId: string; model?: string }) {}

  describe() { return { provider: 'codex', model: this.options.model ?? 'cli-default' }; }

  async generate(request: Parameters<CodeGenerator['generate']>[0], { job, signal }: Parameters<CodeGenerator['generate']>[1]) {
    const { db, store, orgId, model } = this.options;
    if (job?.org_id !== orgId || !job.project_id) throw new JobError('generation_unavailable');
    signal.throwIfAborted();
    const raw = Buffer.from(JSON.stringify(request));
    if (raw.length > remoteGenerationLimit) throw new JobError('generation_request_too_large');
    const prompt = await putBlob(db, store, orgId, raw, 'application/json');
    signal.throwIfAborted();
    const remote = await enqueue(db, {
      orgId, projectId: job.project_id, kind: remoteGenerationKind, subjectType: 'job', subjectId: job.id,
      payload: { input: prompt.sha256, parentAttempt: job.attempt, model }, maxAttempts: 1,
      dedupeKey: `${remoteGenerationKind}:${job.id}:${job.attempt}${request.activeBehaviorId ? ":" + request.activeBehaviorId : ""}`,
    });
    try {
      for (;;) {
        signal.throwIfAborted();
        const [row] = await db.query<{
          status: string; progress: { output?: string } | null; error: { code?: string } | null;
          external_model_allowed: boolean; scope_current: boolean;
        }>(
          `SELECT j.status, j.progress, j.error, o.external_model_allowed,
             (p.deleted_at IS NULL AND p.approved_scope_revision_id=s.id AND p.current_source_revision_id=s.source_revision_id) AS scope_current
           FROM jobs j JOIN organizations o ON o.id=j.org_id
           JOIN projects p ON p.id=j.project_id AND p.org_id=j.org_id
           JOIN scope_revisions s ON s.id=$4 AND s.org_id=j.org_id AND s.project_id=p.id
           WHERE j.id=$1 AND j.org_id=$2 AND j.kind=$3`,
          [remote.id, orgId, remoteGenerationKind, request.scope.id],
        );
        if (!row) throw new JobError('generation_unavailable');
        if (!row.external_model_allowed) throw new JobError('external_model_not_allowed');
        if (!row.scope_current) throw new JobError('scope_changed');
        if (row.status === 'cancelled') throw new JobError('generation_unavailable');
        if (row.status === 'failed') {
          const code = row.error?.code;
          if (code === 'transient' || code === 'worker_lost') throw new RetryableError('remote Codex worker interrupted');
          const known = remoteFailureSchema.safeParse(code);
          throw new JobError(known.success ? known.data : 'generation_provider_error');
        }
        if (row.status === 'succeeded') {
          if (!row.progress?.output) throw new JobError('generation_output_invalid', 'Remote result is missing');
          const validated = remoteResultSchema.safeParse(JSON.parse((await store.get(orgId, row.progress.output)).toString('utf8')));
          if (!validated.success) throw new JobError('generation_output_invalid', 'Remote Codex returned an invalid module');
          return { ...validated.data, transcript: { request, response: validated.data, provider: 'codex', model: this.describe().model } };
        }
        await sleep(750, undefined, { signal });
      }
    } catch (error) {
      await cancel(db, orgId, remote.id).catch(() => {});
      throw error;
    }
  }
}
