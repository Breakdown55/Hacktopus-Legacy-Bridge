import { createHash } from 'node:crypto';
import { uuidv7 } from '../db/ids';
import { enqueue } from '../jobs/queue';
import { digest } from './canonical';
import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { getHeads, moveHead, nextNumber } from './projects';

export const LIMITS = { fileBytes: 200 * 1024 * 1024, revisionBytes: 1024 ** 3, files: 500 };
const ROLES = ['primary_executable', 'shared_library', 'data_file', 'documentation', 'media', 'other'];

export function safePath(p: string): string {
  if (!p || p.startsWith('/') || p.includes('\0') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new DomainError('invalid_path', 422, `Unsafe path: ${p}`);
  return p;
}

export async function createUpload(c: Ctx, projectId: string, i: { filename: string; size: number; sha256: string }) {
  await getHeads(c.db, c.orgId, projectId);
  if (!/^[0-9a-f]{64}$/.test(i.sha256) || !(i.size >= 0)) throw new DomainError('invalid_request', 422);
  if (i.size > LIMITS.fileBytes) throw new DomainError('quota_exceeded', 429, 'File exceeds 200 MiB');
  const id = uuidv7();
  const put = await c.store.presignPut(c.orgId, id, i.sha256, i.size);
  await c.db.query(`INSERT INTO upload_sessions(id,org_id,project_id,filename,declared_size,declared_sha256,staging_key,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '1 hour',$8)`,
    [id, c.orgId, projectId, i.filename, i.size, i.sha256, `orgs/${c.orgId}/staging/${id}`, c.userId]);
  return { upload_id: id, ...put };
}

/** Server HEADs the staged object and checks the size. Hash is verified again when the revision is sealed. */
export async function completeUpload(c: Ctx, uploadId: string) {
  const u = await c.db.query<{ declared_size: string; status: string; expires_at: string }>('SELECT declared_size, status, expires_at FROM upload_sessions WHERE id=$1 AND org_id=$2', [uploadId, c.orgId]);
  if (!u[0]) throw new DomainError('not_found', 404);
  if (u[0].status !== 'pending') return { status: u[0].status };
  if (new Date(u[0].expires_at) < new Date()) { await c.db.query("UPDATE upload_sessions SET status='expired' WHERE id=$1", [uploadId]); throw new DomainError('upload_expired', 409); }
  const st = await c.store.statStaged(c.orgId, uploadId);
  if (!st) throw new DomainError('upload_missing', 409, 'No object was uploaded');
  if (st.size !== Number(u[0].declared_size)) { await c.db.query("UPDATE upload_sessions SET status='rejected' WHERE id=$1", [uploadId]); throw new DomainError('size_mismatch', 422); }
  await c.db.query("UPDATE upload_sessions SET status='received' WHERE id=$1", [uploadId]);
  return { status: 'received' };
}

export interface SealInput { parent_id?: string | null; artifacts: { upload_id: string; path: string; role: string }[]; notes?: string; objectives?: string }

export async function sealSourceRevision(c: Ctx, projectId: string, i: SealInput) {
  const heads = await getHeads(c.db, c.orgId, projectId);
  if (!i.artifacts.length || i.artifacts.length > LIMITS.files) throw new DomainError('invalid_request', 422, 'Between 1 and 500 artifacts required');
  const paths = new Set<string>();
  for (const a of i.artifacts) {
    safePath(a.path);
    if (paths.has(a.path)) throw new DomainError('duplicate_path', 422, a.path);
    paths.add(a.path);
    if (!ROLES.includes(a.role)) throw new DomainError('invalid_role', 422, a.role);
  }
  if (i.artifacts.filter((a) => a.role === 'primary_executable').length !== 1) throw new DomainError('primary_required', 422, 'Exactly one primary_executable is required');

  const sessions = new Map<string, { filename: string; declared_sha256: string; declared_size: string; status: string }>();
  for (const a of i.artifacts) {
    const r = await c.db.query<{ filename: string; declared_sha256: string; declared_size: string; status: string }>('SELECT filename, declared_sha256, declared_size, status FROM upload_sessions WHERE id=$1 AND org_id=$2 AND project_id=$3', [a.upload_id, c.orgId, projectId]);
    if (!r[0]) throw new DomainError('not_found', 404, 'upload');
    if (r[0].status !== 'received') throw new DomainError('upload_not_received', 409, a.path);
    sessions.set(a.upload_id, r[0]);
  }
  const total = [...sessions.values()].reduce((n, s) => n + Number(s.declared_size), 0);
  if (total > LIMITS.revisionBytes) throw new DomainError('quota_exceeded', 429, 'Revision exceeds 1 GiB');

  // Independently re-hash what was actually stored; never trust the declared value.
  for (const [id, s] of sessions) {
    const h = createHash('sha256').update(await c.store.getStaged(c.orgId, id)).digest('hex');
    if (h !== s.declared_sha256) { await c.db.query("UPDATE upload_sessions SET status='rejected' WHERE id=$1", [id]); throw new DomainError('hash_mismatch', 422, s.filename); }
  }

  const revId = uuidv7();
  const promoted = new Set<string>();
  for (const a of i.artifacts) {
    const s = sessions.get(a.upload_id)!;
    if (!promoted.has(s.declared_sha256)) { await c.store.promote(c.orgId, a.upload_id, s.declared_sha256); promoted.add(s.declared_sha256); }
  }
  return c.db.tx(async (t) => {
    const number = await nextNumber(t, 'source_revisions', projectId);
    const manifest = i.artifacts.map((a) => ({ path: a.path, role: a.role, sha256: sessions.get(a.upload_id)!.declared_sha256, size: Number(sessions.get(a.upload_id)!.declared_size) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    const manifestSha = digest(manifest);
    await t.query(`INSERT INTO source_revisions(id,org_id,project_id,number,parent_id,notes,objectives,manifest_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [revId, c.orgId, projectId, number, i.parent_id ?? null, i.notes ?? '', i.objectives ?? '', manifestSha, c.userId]);
    for (const m of manifest) {
      await t.query(`INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [c.orgId, m.sha256, m.size, `orgs/${c.orgId}/blobs/sha256/${m.sha256.slice(0, 2)}/${m.sha256}`]);
      await t.query(`INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`, [revId, c.orgId, m.path, m.role, m.sha256, m.size]);
    }
    for (const a of i.artifacts) await t.query("UPDATE upload_sessions SET status='consumed' WHERE id=$1", [a.upload_id]);
    await moveHead(t, c.orgId, projectId, 'current_source_revision_id', revId, heads.heads_version);
    const job = await enqueue(t, { orgId: c.orgId, projectId, kind: 'inspect', subjectType: 'source_revision', subjectId: revId, dedupeKey: `inspect:${revId}` });
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id,data) VALUES ($1,$2,$3,'source_revision.sealed','source_revision',$4,$5)`, [c.orgId, projectId, c.userId, revId, JSON.stringify({ number, manifest_sha256: manifestSha })]);
    return { id: revId, number, manifest_sha256: manifestSha, artifacts: manifest, jobs: [{ id: job.id, kind: 'inspect' }] };
  });
}

export async function recordExecutionConsent(c: Ctx, sourceId: string, acknowledge: string) {
  if (!acknowledge || acknowledge.length < 10) throw new DomainError('invalid_request', 422, 'Acknowledgement text required');
  const r = await c.db.query("UPDATE source_revisions SET execution_consent_by=$3, execution_consent_at=now() WHERE id=$1 AND org_id=$2 AND execution_consent_at IS NULL RETURNING id", [sourceId, c.orgId, c.userId]);
  if (!r.length) {
    const e = await c.db.query('SELECT 1 FROM source_revisions WHERE id=$1 AND org_id=$2', [sourceId, c.orgId]);
    if (!e.length) throw new DomainError('not_found', 404);
  }
  await c.db.query(`INSERT INTO events(org_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,'execution.consented','source_revision',$3)`, [c.orgId, c.userId, sourceId]);
}

/** Effective eligibility: latest inspect run, with execution refined by the latest probe (§4.2). */
export async function getSourceStatus(c: Ctx, sourceId: string) {
  const rev = await c.db.query<{ project_id: string; execution_consent_at: string | null }>('SELECT project_id, execution_consent_at FROM source_revisions WHERE id=$1 AND org_id=$2', [sourceId, c.orgId]);
  if (!rev[0]) throw new DomainError('not_found', 404);
  const runs = await c.db.query<{ id: string; kind: string; outcome: string | null; eligibility: { analysis: string; execution: string; reasons: string[] } | null; facts: unknown; provider: string; provider_version: unknown }>(
    'SELECT id, kind, outcome, eligibility, facts, provider, provider_version FROM analysis_runs WHERE source_revision_id=$1 AND org_id=$2 ORDER BY created_at DESC, id DESC', [sourceId, c.orgId]);
  const inspect = runs.find((r) => r.kind === 'inspect' && r.outcome);
  const probe = runs.find((r) => r.kind === 'probe' && r.outcome);
  const org = (await c.db.query<{ execution_enabled: boolean }>('SELECT execution_enabled FROM organizations WHERE id=$1', [c.orgId]))[0];
  let analysis = inspect?.eligibility?.analysis ?? 'unknown';
  let execution = inspect?.eligibility?.execution ?? 'unknown';
  let reasons = inspect?.eligibility?.reasons ?? [];
  if (inspect && ['unknown', 'not_permitted'].includes(execution)) {
    if (!org.execution_enabled) { execution = 'not_permitted'; reasons = ['execution_disabled']; }
    else if (!rev[0].execution_consent_at) { execution = 'not_permitted'; reasons = ['consent_missing']; }
    else { execution = 'unknown'; reasons = ['probe_not_run']; }
  }
  if (probe?.eligibility && execution === 'unknown') { execution = probe.eligibility.execution; reasons = probe.eligibility.reasons; }
  return { id: sourceId, eligibility: { analysis: { status: analysis, run_id: inspect?.id ?? null }, execution: { status: execution, reasons } }, inspection: inspect?.facts ?? null, runs: runs.map((r) => ({ id: r.id, kind: r.kind, outcome: r.outcome, provider: r.provider, provider_version: r.provider_version })) };
}
