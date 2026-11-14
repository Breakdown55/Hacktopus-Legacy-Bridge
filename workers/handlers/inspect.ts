import type { Job } from '../../server/jobs/queue';
import { uuidv7 } from '../../server/db/ids';
import { digest } from '../../server/domain/canonical';
import { classify, inspectElf } from '../analysis/builtin-elf/parse';
import { JobError, type JobControl, type WorkerEnv } from '../runtime';
import { sha } from './common';

/** Run-image facts for static eligibility. Must match the lb-run-glibc image (bookworm: glibc 2.36). */
export const RUN_IMAGE = { libraries: ['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libgcc_s.so.1', 'libstdc++.so.6'], glibc: '2.36' };

export async function inspectHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const sourceId = job.subject_id!;
  const arts = await env.db.query<{ path: string; role: string; blob_sha256: string }>('SELECT path, role, blob_sha256 FROM source_artifacts WHERE source_revision_id=$1 AND org_id=$2', [sourceId, job.org_id]);
  const primary = arts.find((a) => a.role === 'primary_executable');
  if (!primary) throw new JobError('primary_missing');
  const bytes = await env.store.get(job.org_id, primary.blob_sha256);
  await ctl.checkpoint({ phase: 'inspecting' });
  const runId = uuidv7();
  const params = { op: 'inspect' };
  const common = [runId, job.org_id, job.project_id, sourceId, job.id, 'inspect', 'builtin-elf', JSON.stringify({ builtin: '1' }), JSON.stringify(params), digest(params)];
  // Independent hash check: the stored bytes must match the artifact record (§4.2).
  if (sha(bytes) !== primary.blob_sha256) {
    await env.db.query(`INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,job_id,kind,provider,provider_version,params,params_digest,outcome,limitations,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'failed',$11,now())`, [...common, JSON.stringify(['hash_mismatch'])]);
    return;
  }
  const insp = inspectElf(bytes);
  const consent = (await env.db.query<{ execution_consent_at: string | null }>('SELECT execution_consent_at FROM source_revisions WHERE id=$1', [sourceId]))[0]?.execution_consent_at;
  const org = (await env.db.query<{ execution_enabled: boolean }>('SELECT execution_enabled FROM organizations WHERE id=$1', [job.org_id]))[0];
  const supplied = arts.filter((a) => a.role === 'shared_library').map((a) => a.path.split('/').pop()!);
  const elig = classify(insp, { suppliedLibraries: supplied, image: RUN_IMAGE, executionEnabled: org.execution_enabled, consent: !!consent });
  const outcome = elig.analysis === 'ineligible' ? 'unsupported' : elig.analysis === 'partial' ? 'partial' : 'complete';
  const facts = { format: insp.format, arch: insp.arch, type: insp.type, interpreter: insp.interpreter, needed: insp.needed, linking: insp.linking, stripped: insp.stripped, hardening: insp.hardening, max_glibc: insp.max_glibc, sections: insp.sections.slice(0, 200), strings: insp.strings.slice(0, 500), string_count: insp.strings.length };
  await env.db.query(`INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,job_id,kind,provider,provider_version,params,params_digest,outcome,eligibility,coverage,limitations,facts,finished_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
    [...common, outcome, JSON.stringify(elig), JSON.stringify({ status: 'complete' }), JSON.stringify(elig.reasons), JSON.stringify(facts)]);
}
