import type { Job } from '../../server/jobs/queue';
import { uuidv7 } from '../../server/db/ids';
import { packTar } from '../../server/tar';
import { putBlob } from '../../server/storage/blobs';
import { JobError, type JobControl, type WorkerEnv } from '../runtime';
import { markerWarnings } from '../build/templates';
import { moduleLanguage } from '@lb/contracts';
import { nativeBuild } from '../build/native';

/** Builds a module revision using its persisted target. Each run records its own diagnostics. */
export async function buildHandler(env: WorkerEnv, job: Job, ctl: JobControl) {
  const moduleId = job.subject_id!;
  const m = (await env.db.query<{ file_manifest: { path: string; sha256: string }[]; origin: string; untranslated: { id: string }[]; scope_revision_id: string; target: string }>('SELECT file_manifest, origin, untranslated, scope_revision_id, target FROM module_revisions WHERE id=$1 AND org_id=$2', [moduleId, job.org_id]))[0];
  const target = moduleLanguage(m.target);
  if (!target) throw new JobError('target_not_supported');
  const files = await Promise.all(m.file_manifest.map(async (f) => ({ path: f.path, content: await env.store.get(job.org_id, f.sha256) })));
  await ctl.checkpoint({ phase: 'building' });
  const started = new Date();
  const out = target === 'typescript' ? await env.build(files) : await nativeBuild(target, files, ctl, env.buildDocker);
  // Marker checks apply to modules that use the convention (generated, or carrying markers / an untranslated list).
  const texts = files.map((f) => ({ path: f.path, content: f.content.toString('utf8') }));
  if (m.origin === 'generated' || m.untranslated.length || texts.some((f) => /LB-(UNTRANSLATED|BEHAVIOR):/.test(f.content))) {
    const scope = (await env.db.query<{ document: { behaviors?: { id: string }[] } }>('SELECT document FROM scope_revisions WHERE id=$1 AND org_id=$2', [m.scope_revision_id, job.org_id]))[0];
    out.diagnostics = [...out.diagnostics, ...markerWarnings(texts, m.untranslated, (scope?.document.behaviors ?? []).map((b) => b.id))];
  }
  const log = await putBlob(env.db, env.store, job.org_id, Buffer.from(out.log), 'text/plain');
  let outputSha: string | null = null;
  if (out.status === 'succeeded') outputSha = (await putBlob(env.db, env.store, job.org_id, packTar(out.files), 'application/x-tar')).sha256;
  await env.db.tx(async (t) => {
    // attempt numbering is per (module, image); concurrent duplicates collide on the unique key and retry.
    const a = (await t.query<{ n: number }>('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM build_results WHERE module_revision_id=$1 AND build_image_digest=$2', [moduleId, out.image]))[0].n;
    await t.query(`INSERT INTO build_results(id,org_id,module_revision_id,attempt,build_image_digest,toolchain,status,diagnostics,log_blob_sha256,output_blob_sha256,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
      [uuidv7(), job.org_id, moduleId, a, out.image, JSON.stringify(out.toolchain), out.status, JSON.stringify(out.diagnostics), log.sha256, outputSha, started]);
  });
  if (out.status === 'error') throw new Error('build infrastructure error');
}
