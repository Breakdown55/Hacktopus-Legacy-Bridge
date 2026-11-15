import { functionNamingSource } from '../../server/domain/generation';
import { DomainError } from '../../server/domain/errors';
import { buildEvidence } from '../generation/evidence';
import { JobError, orgCtx, type JobHandler } from '../runtime';

export const suggestFunctionNameHandler: JobHandler = async (env, job, ctl) => {
  const generator = env.generator;
  if (!generator?.suggestFunctionName) throw new JobError('function_naming_unavailable');
  if (!job.project_id || !job.subject_id) throw new JobError('not_found');
  const ctx = orgCtx(env, job);
  const sourceId = await functionNamingSource(ctx, job.project_id, job.subject_id).catch(error => {
    if (error instanceof DomainError) throw new JobError(error.code);
    throw error;
  });
  const evidence = await buildEvidence(env.db, env.store, job.org_id, sourceId, {
    behaviors: [{ evidence: [job.subject_id] }],
  });
  if (!evidence.some(item => item.kind === 'pseudocode' && item.excerpt.trim())) {
    throw new JobError('function_pseudocode_missing');
  }
  await ctl.checkpoint();
  const suggestion = await generator.suggestFunctionName(evidence, AbortSignal.timeout(60_000));
  await ctl.checkpoint({ suggestion });
};
