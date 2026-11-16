import { JobError, RetryableError } from '../runtime';
import { remoteFailureSchema, remoteResultSchema, type RemoteGenerationJob } from './remote-contract';
import type { CodeGenerator } from './provider';

type Send = (body: object, signal?: AbortSignal) => Promise<Response>;

/** Processing laptop. A lost lease or revoked admission aborts its CLI session. */
export async function processRemoteGeneration(job: RemoteGenerationJob, generator: CodeGenerator, send: Send, shutdown: AbortSignal) {
  const lease = { id: job.id, lease: job.lease };
  const control = new AbortController();
  const deadline = AbortSignal.timeout(9 * 60_000);
  const signal = AbortSignal.any([control.signal, shutdown, deadline]);
  let pending = false;
  const keepAlive = setInterval(async () => {
    if (pending || signal.aborted) return;
    pending = true;
    try {
      const response = await send({ ...lease, action: 'heartbeat' }, signal);
      if (!response.ok || (await response.json()).cancelRequested) control.abort();
    } catch { control.abort(); }
    finally { pending = false; }
  }, 5_000);
  let reply: object;
  try {
    const { files, untranslated, notes, usage, testCases } = await generator.generate(job.request, { signal });
    const result = remoteResultSchema.safeParse({ files, untranslated, notes, usage, testCases });
    reply = result.success ? { action: 'complete', result: result.data }
      : { action: 'fail', error: 'generation_output_invalid' };
  } catch (error) {
    const known = remoteFailureSchema.safeParse(error instanceof JobError ? error.code : undefined);
    const code = deadline.aborted || error instanceof RetryableError ? 'transient'
      : known.success ? known.data : 'generation_provider_error';
    reply = { action: 'fail', error: code };
  } finally { clearInterval(keepAlive); }
  if (shutdown.aborted || control.signal.aborted) return;
  const response = await send({ ...lease, ...reply }, shutdown);
  if (response.status === 400) {
    await send({ ...lease, action: 'fail', error: 'generation_output_invalid' }, shutdown);
  } else if (!response.ok && response.status !== 409) {
    throw new Error('Could not report Codex generation');
  }
}
