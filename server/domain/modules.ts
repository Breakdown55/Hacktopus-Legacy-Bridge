import { uuidv7 } from '../db/ids';
import { moduleTarget, targetOf, type TargetLanguage } from '@lb/contracts';
import { enqueue, finish } from '../jobs/queue';
import { packTar } from '../tar';
import { digest } from './canonical';
import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { assertScopeApproved, getHeads, getProjectTarget, moveHead, nextNumber } from './projects';
import { safePath } from './sources';

export const MODULE_LIMITS = { files: 50, bytes: 512 * 1024 };

/** MVP: no third-party runtime deps. Only `node:` builtins and relative imports are allowed. */
export function findDisallowedImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const s = m[1];
    if (!(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'))) out.push(s);
  }
  return out;
}

export function validateModuleFiles(files: { path: string; content: string }[], language: TargetLanguage = 'typescript') {
  const target = targetOf(language);
  const sourcePath = new RegExp(`^(src|test)/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\\.${target.extension}$`);
  if (!files.length || files.length > MODULE_LIMITS.files) throw new DomainError('generation_output_invalid', 422, `1 to ${MODULE_LIMITS.files} files required`);
  let bytes = 0;
  const seen = new Set<string>();
  for (const f of files) {
    safePath(f.path);
    if (/[\\:\x00-\x1f]/.test(f.path) || Buffer.byteLength(f.path) > 100) {
      throw new DomainError('invalid_path', 422, `Unsafe path: ${f.path}`);
    }
    if (language === 'typescript' ? !/^(src|test)\/.+\.ts$/.test(f.path) : !sourcePath.test(f.path)) {
      throw new DomainError('invalid_path', 422, `Only src/** and test/** .${target.extension} files are allowed: ${f.path}`);
    }
    if (f.content.includes('\0')) throw new DomainError('generation_output_invalid', 422, 'Source must be text');
    const pathKey = f.path.toLowerCase();
    if (seen.has(pathKey)) throw new DomainError('duplicate_path', 422, f.path);
    seen.add(pathKey);
    bytes += Buffer.byteLength(f.content);
    const bad = language === 'typescript' ? findDisallowedImports(f.content) : [];
    if (bad.length) throw new DomainError('disallowed_import', 422, `Non-node: imports are not allowed: ${bad.join(', ')}`);
  }
  if (bytes > MODULE_LIMITS.bytes) throw new DomainError('quota_exceeded', 429, 'Module exceeds 512 KiB');
  if (!files.some(f => f.path === target.entry)) throw new DomainError('entry_missing', 422, `${target.entry} exporting ${target.symbol} is required`);
}

/** Set only by the generation worker; the HTTP API cannot create 'generated' revisions directly. */
export interface GeneratedInfo { generator: Record<string, unknown>; untranslated: unknown[]; jobId: string; workerId: string }
export interface ModuleInput {
  scope_revision_id: string; origin: 'user_edit' | 'customer_upload' | 'generated'; parent_id?: string | null; make_current?: boolean;
  files?: { path: string; content: string }[];
  changes?: { path: string; content?: string; delete?: boolean }[];
}

async function filesOf(c: Ctx, moduleId: string): Promise<{ path: string; content: string }[]> {
  const m = await c.db.query<{ file_manifest: { path: string; sha256: string }[] }>('SELECT file_manifest FROM module_revisions WHERE id=$1 AND org_id=$2', [moduleId, c.orgId]);
  if (!m[0]) throw new DomainError('not_found', 404, 'module');
  return Promise.all(m[0].file_manifest.map(async (f) => ({ path: f.path, content: (await c.store.get(c.orgId, f.sha256)).toString('utf8') })));
}

/** Creates an immutable module revision against an approved scope and enqueues its build. */
export async function createModuleRevision(c: Ctx, projectId: string, i: ModuleInput, generated?: GeneratedInfo) {
  if ((i.origin === 'generated') !== !!generated) throw new DomainError('invalid_request', 422, 'generated revisions come from the generation worker');
  const heads = await getHeads(c.db, c.orgId, projectId);
  const target = await getProjectTarget(c.db, c.orgId, projectId);
  await assertScopeApproved(c.db, c.orgId, projectId, i.scope_revision_id);
  let files = i.files ?? [];
  if (i.changes) {
    if (!i.parent_id) throw new DomainError('invalid_request', 422, 'changes require parent_id');
    const map = new Map((await filesOf(c, i.parent_id)).map((f) => [f.path, f.content]));
    for (const ch of i.changes) { if (ch.delete) map.delete(ch.path); else map.set(ch.path, ch.content ?? ''); }
    files = [...map].map(([path, content]) => ({ path, content }));
  }
  validateModuleFiles(files, target.id);
  const stored = await Promise.all(files.map(async (f) => ({ path: f.path, ...(await c.store.put(c.orgId, Buffer.from(f.content))) })));
  const manifest = stored.map((s) => ({ path: s.path, sha256: s.sha256, size: s.size })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const tarBlob = await c.store.put(c.orgId, packTar(files.map((f) => ({ path: f.path, content: Buffer.from(f.content) }))));
  const treeSha = digest(manifest);
  const id = uuidv7();
  // An edit keeps the parent's untranslated list; the build cross-check flags any marker that no longer matches.
  let untranslated: unknown[] = generated?.untranslated ?? [];
  if (!generated && i.origin === 'user_edit' && i.parent_id) {
    const p = await c.db.query<{ untranslated: unknown[] }>('SELECT untranslated FROM module_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [i.parent_id, c.orgId, projectId]);
    untranslated = p[0]?.untranslated ?? [];
  }
  const isHead = !i.parent_id || i.parent_id === heads.current_module_revision_id;
  return c.db.tx(async (t) => {
    if (generated) {
      const [project] = await t.query<{ approved: string; source_matches: boolean }>(
        `SELECT p.approved_scope_revision_id AS approved, p.current_source_revision_id=s.source_revision_id AS source_matches
         FROM projects p JOIN scope_revisions s ON s.org_id=p.org_id AND s.project_id=p.id AND s.id=$3
         WHERE p.org_id=$1 AND p.id=$2 AND p.deleted_at IS NULL FOR UPDATE OF p`, [c.orgId, projectId, i.scope_revision_id],
      );
      if (project?.approved !== i.scope_revision_id || !project.source_matches) throw new DomainError('scope_changed', 409);
      const [org] = await t.query<{ external_model_allowed: boolean }>(
        'SELECT external_model_allowed FROM organizations WHERE id=$1 FOR SHARE', [c.orgId],
      );
      if (!org?.external_model_allowed) throw new DomainError('external_model_not_allowed', 409);
      const job = await t.query(`SELECT id FROM jobs WHERE id=$1 AND org_id=$2 AND project_id=$3 AND kind='generate'
        AND subject_id=$4 AND lease_owner=$5 AND status='running' AND lease_expires_at>now()
        AND cancel_requested_at IS NULL FOR UPDATE`, [generated.jobId, c.orgId, projectId, i.scope_revision_id, generated.workerId]);
      if (!job.length) throw new DomainError('generation_lease_lost', 409);
    }
    for (const s of stored) await t.query('INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [c.orgId, s.sha256, s.size, s.key]);
    await t.query('INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [c.orgId, tarBlob.sha256, tarBlob.size, tarBlob.key]);
    const number = await nextNumber(t, 'module_revisions', projectId);
    await t.query(`INSERT INTO module_revisions(id,org_id,project_id,number,parent_id,scope_revision_id,origin,source_tree_blob_sha256,tree_sha256,file_manifest,untranslated,generator,created_by,target) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, c.orgId, projectId, number, i.parent_id ?? null, i.scope_revision_id, i.origin, tarBlob.sha256, treeSha, JSON.stringify(manifest), JSON.stringify(untranslated), generated ? JSON.stringify(generated.generator) : null, c.userId, moduleTarget(target.id)]);
    let isCurrent = false;
    if (isHead || i.make_current) { await moveHead(t, c.orgId, projectId, 'current_module_revision_id', id, heads.heads_version); isCurrent = true; }
    const job = await enqueue(t, { orgId: c.orgId, projectId, kind: 'build', subjectType: 'module_revision', subjectId: id, dedupeKey: `build:${id}` });
    await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'module_revision.created','module_revision',$4)`, [c.orgId, projectId, c.userId, id]);
    if (generated && !await finish(t, generated.jobId, generated.workerId, { status: 'succeeded' })) {
      throw new DomainError('generation_lease_lost', 409);
    }
    return { id, number, tree_sha256: treeSha, build: { status: 'building', job_id: job.id }, is_current: isCurrent };
  });
}

export async function getModuleFiles(c: Ctx, moduleId: string) { return filesOf(c, moduleId); }
