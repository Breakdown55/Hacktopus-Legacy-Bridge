import type { CaseInput } from '@lb/contracts';
import type { Job } from '../../server/jobs/queue';
import { uuidv7 } from '../../server/db/ids';
import { digest } from '../../server/domain/canonical';
import { createCaseSet, type CaseSetEntry } from '../../server/domain/cases';
import { getHeads } from '../../server/domain/projects';
import { orgCtx, type JobControl, type WorkerEnv } from '../runtime';
import { jobDir, stageSource, storeObservation, tmpIn, toCaseRun, variedChannels } from './common';
import type { RunOutcome } from '../execution/harness';

/**
 * Reference capture (§7.4): run the original `repeat` times per case. Byte-identical => deterministic reference;
 * otherwise stored with deterministic=false and a variance summary. Incomplete observations write no reference.
 * Retries are idempotent: a case that already has a reference from this job is skipped.
 */
export async function captureHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const p = job.payload as { source_revision_id: string; environment_id: string; test_case_ids: string[]; repeat: number };
  const dir = jobDir(env, job.id);
  const envRow = (await env.db.query<{ image_digest: string }>('SELECT image_digest FROM execution_environments WHERE id=$1', [p.environment_id]))[0];
  const srcDir = tmpIn(dir, 'src-');
  const stage = await stageSource(env.db, env.store, job.org_id, p.source_revision_id, srcDir);

  const refs = new Map<string, string>();
  const couldnt: { test_case_id: string; reason: string }[] = [];
  let done = 0;
  for (const tcId of p.test_case_ids) {
    await ctl.checkpoint({ phase: 'capturing', completed: done, total: p.test_case_ids.length, message: `case ${tcId}` });
    const existing = await env.db.query<{ id: string }>('SELECT id FROM reference_outputs WHERE capture_job_id=$1 AND test_case_id=$2 AND org_id=$3', [job.id, tcId, job.org_id]);
    if (existing[0]) { refs.set(tcId, existing[0].id); done++; continue; }
    const tc = (await env.db.query<{ input: CaseInput }>('SELECT input FROM test_cases WHERE id=$1 AND org_id=$2', [tcId, job.org_id]))[0];
    const run = await toCaseRun(env.store, job.org_id, tc.input);
    const outs: RunOutcome[] = [];
    let bad: string | null = null;
    for (let i = 0; i < p.repeat; i++) {
      const o = await env.original.run({ artifactDir: srcDir, binaryRel: stage.binaryRel, hasLibs: stage.hasLibs, imageDigest: envRow.image_digest, workdir: tmpIn(dir, 'w-'), case: run });
      if (o.incomplete) { bad = o.incomplete.reason; break; }
      outs.push(o);
    }
    if (bad) { couldnt.push({ test_case_id: tcId, reason: bad }); done++; continue; }
    const varied = new Set<string>();
    for (let i = 1; i < outs.length; i++) for (const c of variedChannels(outs[0], outs[i])) varied.add(c);
    const obs = await storeObservation(env.db, env.store, job.org_id, outs[0]);
    const id = uuidv7();
    await env.db.query(`INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,source_revision_id,execution_env_id,capture_job_id,observation,repeat_count,deterministic,variance) VALUES ($1,$2,$3,'captured_original',$4,$5,$6,$7,$8,$9,$10)`,
      [id, job.org_id, tcId, p.source_revision_id, p.environment_id, job.id, JSON.stringify(obs), outs.length, varied.size === 0, varied.size ? JSON.stringify({ channels: [...varied] }) : null]);
    await env.db.query(`INSERT INTO events(org_id,project_id,type,subject_type,subject_id) VALUES ($1,$2,'reference.captured','reference_output',$3)`, [job.org_id, job.project_id, id]);
    refs.set(tcId, id);
    done++;
  }

  // New references are attached by a NEW case-set revision, never by mutating an old one.
  const heads = await getHeads(env.db, job.org_id, job.project_id!);
  const parent = heads.current_case_set_revision_id
    ? (await env.db.query<{ entries: CaseSetEntry[] }>('SELECT entries FROM case_set_revisions WHERE id=$1', [heads.current_case_set_revision_id]))[0].entries
    : [];
  const map = new Map(parent.map((e) => [e.test_case_id, e]));
  for (const tcId of p.test_case_ids) map.set(tcId, { test_case_id: tcId, reference_output_id: refs.get(tcId) ?? map.get(tcId)?.reference_output_id ?? null });
  const entries = [...map.values()];
  let caseSetId: string | null = heads.current_case_set_revision_id;
  if (!parent.length || digest(entries) !== digest(parent)) caseSetId = (await createCaseSet(orgCtx(env, job), job.project_id!, entries)).id;
  await ctl.checkpoint({ phase: 'done', completed: done, total: p.test_case_ids.length, case_set_revision_id: caseSetId, couldnt_run: couldnt, references: refs.size });
}
