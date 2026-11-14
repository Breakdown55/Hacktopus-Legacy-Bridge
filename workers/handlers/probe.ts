import type { Job } from '../../server/jobs/queue';
import { uuidv7 } from '../../server/db/ids';
import { digest } from '../../server/domain/canonical';
import type { JobControl, WorkerEnv } from '../runtime';
import { jobDir, stageSource, tmpIn } from './common';

/** Execution probe: one run in the sandbox. A complete observation (even nonzero exit) means runnable (§1.3). */
export async function probeHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const p = job.payload as { source_revision_id: string; environment_id: string; argv?: string[]; stdin_text?: string };
  const dir = jobDir(env, job.id);
  const envRow = (await env.db.query<{ image_digest: string }>('SELECT image_digest FROM execution_environments WHERE id=$1', [p.environment_id]))[0];
  const srcDir = tmpIn(dir, 'src-');
  const stage = await stageSource(env.db, env.store, job.org_id, p.source_revision_id, srcDir);
  await ctl.checkpoint({ phase: 'probing' });
  const out = await env.original.run({ artifactDir: srcDir, binaryRel: stage.binaryRel, hasLibs: stage.hasLibs, imageDigest: envRow.image_digest, workdir: tmpIn(dir, 'w-'), case: { argv: p.argv ?? [], caseEnv: {}, stdin: Buffer.from(p.stdin_text ?? ''), files: [], timeoutMs: 10_000 } });
  const runnable = !out.incomplete;
  const elig = runnable ? { analysis: 'eligible', execution: 'runnable', reasons: ['probe_ok'] } : { analysis: 'eligible', execution: 'not_runnable', reasons: [`probe_${out.incomplete!.reason}`] };
  const params = { argv: p.argv ?? [] };
  await env.db.query(`INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,job_id,kind,provider,provider_version,params,params_digest,outcome,eligibility,finished_at) VALUES ($1,$2,$3,$4,$5,'probe','sandbox-probe',$6,$7,$8,'complete',$9,now())`,
    [uuidv7(), job.org_id, job.project_id, p.source_revision_id, job.id, JSON.stringify({ image: envRow.image_digest }), JSON.stringify(params), digest(params), JSON.stringify(elig)]);
}
