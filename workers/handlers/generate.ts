import type { Job } from '../../server/jobs/queue';
import { ScopeDocV1 } from '@lb/contracts';
import { digest } from '../../server/domain/canonical';
import { DomainError } from '../../server/domain/errors';
import { getHeads, getProjectTarget } from '../../server/domain/projects';
import { createModuleRevision, getModuleFiles } from '../../server/domain/modules';
import { putBlob } from '../../server/storage/blobs';
import { generateIncrementally, featureStates } from '../generation/incremental';
import { supplementalEvidence } from '../generation/supplemental-evidence';
import { buildEvidence } from '../generation/evidence';
import { generationTarget, PORTABLE_TEMPLATE_VERSION, TEMPLATE_VERSION, type GenerationRequest } from '../generation/provider';
import { GenerationOutputInvalid, validateGenerated } from '../generation/validate';
import { JobError, LeaseLostError, RetryableError, orgCtx, type JobControl, type WorkerEnv } from '../runtime';

/** Generates a module revision from the approved scope. A model failure or invalid output fails the job and creates no revision. */
export async function generateHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const gen = env.generator;
  if (!gen) throw new JobError('generation_unavailable');
  const p = job.payload as { scope_revision_id: string; parent_id: string | null; instructions: string; incremental?: boolean; sample_input?: { name: string; text: string }; unknown_questions?: string[]; user_id: string | null };
  const projectId = job.project_id!;
  const ctx = orgCtx(env, job, p.user_id);
  // Re-check at run time: the setting or the approved head may have changed since the request.
  const org = (await env.db.query<{ external_model_allowed: boolean }>('SELECT external_model_allowed FROM organizations WHERE id=$1', [job.org_id]))[0];
  if (!org?.external_model_allowed) throw new JobError('external_model_not_allowed');
  const heads = await getHeads(env.db, job.org_id, projectId);
  const target = await getProjectTarget(env.db, job.org_id, projectId);
  if (heads.approved_scope_revision_id !== p.scope_revision_id) throw new JobError('scope_changed');
  // A retried job must not create a second revision.
  const done = await env.db.query<{ id: string }>(`SELECT id FROM module_revisions WHERE org_id=$1 AND project_id=$2 AND generator->>'job_id'=$3`, [job.org_id, projectId, job.id]);
  if (done.length) return;

  const scope = (await env.db.query<{ document: Record<string, unknown>; document_sha256: string; source_revision_id: string }>('SELECT document, document_sha256, source_revision_id FROM scope_revisions WHERE id=$1 AND org_id=$2', [p.scope_revision_id, job.org_id]))[0];
  if (!scope || scope.source_revision_id !== heads.current_source_revision_id) throw new JobError('scope_changed');
  const parsed = ScopeDocV1.safeParse(scope.document);
  if (!parsed.success) throw new JobError('scope_invalid');
  await ctl.checkpoint({ phase: 'collecting_evidence' });
  const evidence = await buildEvidence(env.db, env.store, job.org_id, scope.source_revision_id, scope.document);
  evidence.push(...await supplementalEvidence(env.db, env.store, job.org_id, scope.source_revision_id, evidence));
  let priorRevision: GenerationRequest['priorRevision'];
  if (p.parent_id) {
    const files = await getModuleFiles(ctx, p.parent_id);
    const b = (await env.db.query<{ diagnostics: unknown[] }>('SELECT diagnostics FROM build_results WHERE module_revision_id=$1 ORDER BY attempt DESC LIMIT 1', [p.parent_id]))[0];
    priorRevision = { id: p.parent_id, files, buildDiagnostics: b?.diagnostics };
  }
  const request: GenerationRequest = {
    templateVersion: target.id === 'typescript' ? TEMPLATE_VERSION : PORTABLE_TEMPLATE_VERSION, scope: { id: p.scope_revision_id, sha256: scope.document_sha256, document: parsed.data }, evidence,
    target: generationTarget(target.id),
    priorRevision, instructions: p.instructions || undefined, sampleInput: p.sample_input, unansweredQuestions: p.unknown_questions ?? [],
  };
  await ctl.checkpoint({ phase: 'generating' });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), (p.incremental ? Math.min(30, Math.max(10, parsed.data.behaviors.length * 3)) : 10) * 60_000);
  let checking: Promise<void> | undefined;
  let interrupted: unknown;
  const heartbeat = setInterval(() => {
    if (checking || abort.signal.aborted) return;
    checking = ctl.checkpoint().catch(error => { interrupted = error; abort.abort(); })
      .finally(() => { checking = undefined; });
  }, 5_000);
  let result;
  try {
    result = p.incremental
      ? await generateIncrementally(gen, request, { signal: abort.signal, job }, features => ctl.checkpoint({ phase: 'generating', features }))
      : await gen.generate(request, { signal: abort.signal, job });
  } catch (error) {
    if (interrupted) throw interrupted;
    if (error instanceof GenerationOutputInvalid) throw new JobError('generation_output_invalid', error.detail);
    await ctl.checkpoint();
    if (abort.signal.aborted) throw new RetryableError('generation timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    await checking;
  }
  if (interrupted) throw interrupted;
  await ctl.checkpoint({ phase: 'validating', features: featureStates(request, result) });
  let untranslated;
  try { untranslated = validateGenerated(result, new Set(parsed.data.behaviors.map((b) => b.id)), target.id); }
  catch (e) {
    if (e instanceof GenerationOutputInvalid) throw new JobError('generation_output_invalid', e.detail);
    throw e;
  }
  // A skipped question cannot silently disappear during repair. Keep its recorded gap.
  if (p.parent_id && p.unknown_questions?.length) {
    const [prior] = await env.db.query<{ untranslated: typeof untranslated }>('SELECT untranslated FROM module_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [p.parent_id, job.org_id, projectId]);
    for (const gap of prior?.untranslated ?? []) {
      if (p.unknown_questions.includes(gap.id) && !untranslated.some(u => u.id === gap.id)) untranslated.push(gap);
    }
  }
  const transcript = await putBlob(env.db, env.store, job.org_id, Buffer.from(JSON.stringify(result.transcript ?? null)), 'application/json');
  const d = gen.describe();
  const generator = {
    job_id: job.id, provider: d.provider, model: d.model, model_version: result.modelVersion ?? null, template_version: request.templateVersion,
    params: { evidence_items: evidence.length, repair: !!p.parent_id, incremental: !!p.incremental }, input_digest: digest(request), output_digest: digest(result.files),
    test_cases: result.testCases ?? [], feature_states: featureStates(request, { ...result, untranslated }),
    transcript_blob: transcript.sha256, usage: result.usage, notes: result.notes.slice(0, 2000),
  };
  try {
    await createModuleRevision(ctx, projectId,
      { scope_revision_id: p.scope_revision_id, origin: 'generated', parent_id: p.parent_id, files: result.files },
      { generator, untranslated, jobId: job.id, workerId: env.workerId });
    return 'finalized' as const;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === 'generation_lease_lost') {
      await ctl.checkpoint();
      throw new LeaseLostError();
    }
    if (error.code === 'scope_changed' || error.code === 'external_model_not_allowed') throw new JobError(error.code);
    throw error;
  }
}
