/**
 * S7 retention and purge (plan §3.10, §8.4), driven through the domain functions with a real FsBlobStore.
 * Substitutes: PGlite by default (single connection) or real PostgreSQL with TEST_DATABASE_URL; FsBlobStore, not S3 (the S3 delete is
 * covered separately against S3Mock in tests/integration/s3.test.ts). The purge runs as role lb_purge from migration 0003.
 * Discriminating cases: a blob shared by two projects survives purging one of them; another org's identical bytes are untouched;
 * a purge before the grace period or a second purge does nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { blobKey, stagingKey } from '../../server/storage/blobstore';
import { purgeExpired, referencedBlobs } from '../../server/domain/purge';
import { purgeHandler } from '../../workers/handlers/purge';
import type { WorkerEnv } from '../../workers/runtime';

let db: Db, store: FsBlobStore, root: string;
const orgA = uuidv7(), orgB = uuidv7(), user = uuidv7();
const exists = (org: string, sha: string) => existsSync(join(root, blobKey(org, sha)));
const count = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, p))[0].n);

async function blob(org: string, text: string, media = 'application/octet-stream') {
  const b = await store.put(org, Buffer.from(text));
  await db.query('INSERT INTO blobs(org_id,sha256,size_bytes,storage_key,media_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [org, b.sha256, b.size, b.key, media]);
  return b.sha256;
}

/** One project with a row in every project-scoped table, each pointing at the blobs given. */
async function seedProject(org: string, name: string, b: { source: string; finding: string; module: string; build: string; input: string; reference: string; actual: string; zip: string; shared?: string }) {
  const p = uuidv7(), src = uuidv7(), run = uuidv7(), scope = uuidv7(), mod = uuidv7(), tc = uuidv7(), ref = uuidv7(), cs = uuidv7(), pol = uuidv7(), vr = uuidv7(), job = uuidv7(), env = uuidv7();
  const q = (sql: string, params: unknown[]) => db.query(sql, params);
  await q("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,$3)", [p, org, name]);
  await q("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,$4)", [src, org, p, 'a'.repeat(64)]);
  await q("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/tool','primary_executable',$3,1)", [src, org, b.source]);
  await q("INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,kind,provider,params_digest,outcome) VALUES ($1,$2,$3,$4,'index','rea-ghidra','d','complete')", [run, org, p, src]);
  await q(`INSERT INTO findings(id,org_id,source_revision_id,analysis_run_id,kind,stable_key,name,address,authority,attributes,location,artifact_path,artifact_sha256,provider_evidence_id,content_blob_sha256)
           VALUES ($1,$2,$3,$4,'function','fn:1','f','0x1000','tool_inferred','{}','{}','bin/tool',$5,$6,$7)`, [uuidv7(), org, src, run, b.source, 'ev_' + 'b'.repeat(64), b.finding]);
  await q("INSERT INTO scope_drafts(project_id,org_id,document) VALUES ($1,$2,'{}')", [p, org]);
  await q("INSERT INTO scope_revisions(id,org_id,project_id,number,source_revision_id,document,document_sha256,created_by) VALUES ($1,$2,$3,1,$4,'{}',$5,$6)", [scope, org, p, src, 'c'.repeat(64), user]);
  await q("INSERT INTO approvals(id,org_id,scope_revision_id,document_sha256,decision,decided_by) VALUES ($1,$2,$3,$4,'approved',$5)", [uuidv7(), org, scope, 'c'.repeat(64), user]);
  const manifest = [{ path: 'src/index.ts', sha256: b.module }, ...(b.shared ? [{ path: 'src/shared.ts', sha256: b.shared }] : [])];
  await q("INSERT INTO module_revisions(id,org_id,project_id,number,scope_revision_id,origin,source_tree_blob_sha256,tree_sha256,file_manifest,generator) VALUES ($1,$2,$3,1,$4,'customer_upload',$5,$6,$7,$8)",
    [mod, org, p, scope, b.module, 'e'.repeat(64), JSON.stringify(manifest), JSON.stringify({ transcript_blob: b.finding })]);
  await q("INSERT INTO build_results(id,org_id,module_revision_id,attempt,build_image_digest,status,output_blob_sha256) VALUES ($1,$2,$3,1,'img','succeeded',$4)", [uuidv7(), org, mod, b.build]);
  await q("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin) VALUES ($1,$2,$3,'c',$4,$5,'user')", [tc, org, p, JSON.stringify({ argv: [], stdin_blob: b.input, files: b.shared ? [{ path: 'x', blob: b.shared }] : [] }), 'f'.repeat(64)]);
  await q("INSERT INTO execution_environments(id,name,version,role,image_digest,arch) VALUES ($1,$2,1,'original','img','x86-64') ON CONFLICT DO NOTHING", [env, 'env-' + env]);
  await q("INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation,attestation,supplied_by) VALUES ($1,$2,$3,'user_supplied',$4,'attested',$5)", [ref, org, tc, JSON.stringify({ stdout: { sha256: b.reference, blob: b.reference } }), user]);
  await q("INSERT INTO case_set_revisions(id,org_id,project_id,number,entries,digest) VALUES ($1,$2,$3,1,$4,'d')", [cs, org, p, JSON.stringify([{ test_case_id: tc, reference_output_id: ref }])]);
  await q("INSERT INTO comparison_policies(id,org_id,project_id,number,rules,digest) VALUES ($1,$2,$3,1,'{}','d')", [pol, org, p]);
  await q("INSERT INTO verification_runs(id,org_id,project_id,source_revision_id,scope_revision_id,module_revision_id,build_result_id,case_set_revision_id,comparison_policy_id,replacement_env_id,binding,binding_digest,completeness,summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,'complete','{}')",
    [vr, org, p, src, scope, mod, uuidv7(), cs, pol, env, uuidv7()]);
  await q("INSERT INTO verification_results(id,org_id,verification_run_id,test_case_id,reference_output_id,outcome,actual) VALUES ($1,$2,$3,$4,$5,'match',$6)", [uuidv7(), org, vr, tc, ref, JSON.stringify({ stdout: { blob: b.actual } })]);
  await q("INSERT INTO export_packages(id,org_id,project_id,verification_run_id,binding_digest,package_blob_sha256,expires_at) VALUES ($1,$2,$3,$4,'bd',$5, now() + interval '30 days')", [uuidv7(), org, p, vr, b.zip]);
  await q("INSERT INTO upload_sessions(id,org_id,project_id,filename,declared_size,declared_sha256,status,staging_key,expires_at) VALUES ($1,$2,$3,'f',1,$4,'consumed','k', now())", [uuidv7(), org, p, b.source]);
  await q("INSERT INTO jobs(id,org_id,project_id,kind,status) VALUES ($1,$2,$3,'build','succeeded')", [job, org, p]);
  await q("INSERT INTO events(org_id,project_id,type,subject_type,subject_id,data) VALUES ($1,$2,'scope.decided','scope_revision',$3,$4)", [org, p, scope, JSON.stringify({ scope_revision_id: scope, comment: 'customer secret text', note: 'also private' })]);
  return { p, src, tc };
}
const uniques = (org: string, tag: string) => Promise.all(['source', 'finding', 'module', 'build', 'input', 'reference', 'actual', 'zip'].map((k) => blob(org, `${tag}-${k}`))).then((v) => ({ source: v[0], finding: v[1], module: v[2], build: v[3], input: v[4], reference: v[5], actual: v[6], zip: v[7] }));

beforeAll(async () => {
  db = await testDb();
  root = mkdtempSync(join(tmpdir(), 'purge-blobs-'));
  store = new FsBlobStore(root);
  for (const o of [orgA, orgB]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
});

describe('S7 purge', () => {
  let p1: Awaited<ReturnType<typeof seedProject>>, p2: typeof p1, q: typeof p1;
  let u1: Awaited<ReturnType<typeof uniques>>, u2: typeof u1, uq: typeof u1, shared: string, sharedB: string;

  it('seeds two projects sharing a blob, and an unrelated org holding the same bytes', async () => {
    shared = await blob(orgA, 'shared bytes');
    sharedB = await blob(orgB, 'shared bytes'); // same content, other org: a different key and row
    expect(sharedB).toBe(shared);
    u1 = await uniques(orgA, 'p1'); u2 = await uniques(orgA, 'p2'); uq = await uniques(orgB, 'q');
    p1 = await seedProject(orgA, 'one', { ...u1, shared });
    p2 = await seedProject(orgA, 'two', { ...u2, shared });
    q = await seedProject(orgB, 'other org', { ...uq, shared: sharedB });
    const live = await referencedBlobs(db, orgA);
    for (const sha of [...Object.values(u1), ...Object.values(u2), shared]) expect(live.has(sha), sha).toBe(true);
  });

  it('does nothing for a project that is not deleted, or is still inside the grace period', async () => {
    expect((await purgeExpired(db, store)).projects_purged).toEqual([]);
    await db.query('UPDATE projects SET deleted_at = now() WHERE id=$1', [p1.p]);
    const r = await purgeExpired(db, store);
    expect(r.projects_purged).toEqual([]); // deleted just now: inside the 7-day grace
    expect(await count('SELECT 1 FROM projects WHERE id=$1', [p1.p])).toBe(1);
    expect(exists(orgA, u1.source)).toBe(true);
  });

  it('purges after the grace period: rows and unique blobs go, the shared blob and other projects survive', async () => {
    await db.query("UPDATE projects SET deleted_at = now() - interval '8 days' WHERE id=$1", [p1.p]);
    const r = await purgeExpired(db, store);
    expect(r.projects_purged).toEqual([p1.p]);
    expect(r.orphaned_keys).toEqual([]);

    // project 1: every row is gone
    for (const t of ['source_revisions', 'scope_revisions', 'module_revisions', 'test_cases', 'case_set_revisions', 'comparison_policies', 'verification_runs', 'export_packages', 'upload_sessions', 'jobs', 'scope_drafts', 'analysis_runs']) {
      expect(await count(`SELECT 1 FROM ${t} WHERE project_id=$1`, [p1.p]), t).toBe(0);
    }
    expect(await count('SELECT 1 FROM projects WHERE id=$1', [p1.p])).toBe(0);
    expect(await count('SELECT 1 FROM source_artifacts WHERE source_revision_id=$1', [p1.src])).toBe(0);
    expect(await count('SELECT 1 FROM findings WHERE source_revision_id=$1', [p1.src])).toBe(0);
    expect(await count('SELECT 1 FROM reference_outputs WHERE test_case_id=$1', [p1.tc])).toBe(0);

    // its unique blobs are gone from the table AND the store; the shared blob survives
    for (const sha of Object.values(u1)) {
      expect(await count('SELECT 1 FROM blobs WHERE org_id=$1 AND sha256=$2', [orgA, sha]), sha).toBe(0);
      expect(exists(orgA, sha), sha).toBe(false);
    }
    expect(r.blobs_deleted).toBe(Object.values(u1).length);
    expect(await count('SELECT 1 FROM blobs WHERE org_id=$1 AND sha256=$2', [orgA, shared])).toBe(1);
    expect(exists(orgA, shared)).toBe(true);

    // project 2 in the same org is intact, including its blobs
    expect(await count('SELECT 1 FROM projects WHERE id=$1', [p2.p])).toBe(1);
    expect(await count('SELECT 1 FROM verification_results WHERE verification_run_id IN (SELECT id FROM verification_runs WHERE project_id=$1)', [p2.p])).toBe(1);
    for (const sha of Object.values(u2)) { expect(exists(orgA, sha), sha).toBe(true); expect(await count('SELECT 1 FROM blobs WHERE org_id=$1 AND sha256=$2', [orgA, sha])).toBe(1); }

    // the other org is untouched, including the identical bytes under its own key
    expect(await count('SELECT 1 FROM projects WHERE id=$1', [q.p])).toBe(1);
    expect(exists(orgB, sharedB)).toBe(true);
    for (const sha of Object.values(uq)) expect(exists(orgB, sha), sha).toBe(true);
  });

  it('keeps the audit events but reduces their data to ids', async () => {
    const ev = await db.query<{ type: string; data: Record<string, unknown> }>('SELECT type, data FROM events WHERE project_id=$1 ORDER BY id', [p1.p]);
    expect(ev.map((e) => e.type)).toEqual(['scope.decided', 'project.purged']);
    expect(Object.keys(ev[0].data)).toEqual(['scope_revision_id']);
    expect(JSON.stringify(ev)).not.toContain('customer secret');
    const other = await db.query<{ data: Record<string, unknown> }>('SELECT data FROM events WHERE project_id=$1', [p2.p]);
    expect(Object.keys(other[0].data).sort()).toEqual(['comment', 'note', 'scope_revision_id']); // other projects are not reduced
  });

  it('is a no-op when run again', async () => {
    const r = await purgeExpired(db, store);
    expect(r).toEqual({ projects_purged: [], blobs_deleted: 0, staging_deleted: 0, export_zips_deleted: 0, orphaned_keys: [] });
    expect(await count("SELECT 1 FROM events WHERE type='project.purged' AND project_id=$1", [p1.p])).toBe(1);
  });

  it('purging the last project that uses the shared blob finally removes it', async () => {
    await db.query("UPDATE projects SET deleted_at = now() - interval '9 days' WHERE id=$1", [p2.p]);
    const r = await purgeExpired(db, store, { orgId: orgA });
    expect(r.projects_purged).toEqual([p2.p]);
    expect(exists(orgA, shared)).toBe(false);
    expect(await count('SELECT 1 FROM blobs WHERE org_id=$1', [orgA])).toBe(0);
    expect(exists(orgB, sharedB)).toBe(true); // still the other org's
  });

  it('removes expired staging uploads and expired export zips but keeps the export manifest row', async () => {
    const proj = uuidv7(), vr = uuidv7();
    const keep = await blob(orgA, 'zip keep'), gone = await blob(orgA, 'zip gone');
    await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'exp')", [proj, orgA]);
    await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [uuidv7(), orgA, proj]);
    await db.query("INSERT INTO verification_runs(id,org_id,project_id,source_revision_id,scope_revision_id,module_revision_id,build_result_id,case_set_revision_id,comparison_policy_id,replacement_env_id,binding,binding_digest) VALUES ($1,$2,$3,$4,$4,$4,$4,$4,$4,$4,'{}',$5)", [vr, orgA, proj, uuidv7(), uuidv7()]);
    const oldEx = uuidv7(), newEx = uuidv7();
    await db.query("INSERT INTO export_packages(id,org_id,project_id,verification_run_id,binding_digest,package_blob_sha256,expires_at) VALUES ($1,$2,$3,$4,'b',$5, now() - interval '1 day')", [oldEx, orgA, proj, vr, gone]);
    await db.query("INSERT INTO export_packages(id,org_id,project_id,verification_run_id,binding_digest,package_blob_sha256,expires_at) VALUES ($1,$2,$3,$4,'b',$5, now() + interval '5 days')", [newEx, orgA, proj, vr, keep]);
    const stale = uuidv7(), fresh = uuidv7();
    for (const [id, age] of [[stale, '30 hours'], [fresh, '1 hour']]) {
      await db.query(`INSERT INTO upload_sessions(id,org_id,project_id,filename,declared_size,declared_sha256,status,staging_key,expires_at,created_at) VALUES ($1,$2,$3,'f',1,$4,'pending','k', now(), now() - interval '${age}')`, [id, orgA, proj, 'a'.repeat(64)]);
      const f = join(root, stagingKey(orgA, id));
      await (await import('node:fs/promises')).mkdir(join(root, 'orgs', orgA, 'staging'), { recursive: true });
      await (await import('node:fs/promises')).writeFile(f, 'x');
    }
    const r = await purgeExpired(db, store, { orgId: orgA });
    expect(r).toMatchObject({ projects_purged: [], staging_deleted: 1, export_zips_deleted: 1 });
    expect(existsSync(join(root, stagingKey(orgA, stale)))).toBe(false);
    expect(existsSync(join(root, stagingKey(orgA, fresh)))).toBe(true);
    expect((await db.query<{ status: string }>('SELECT status FROM upload_sessions WHERE id=$1', [stale]))[0].status).toBe('expired');
    expect(exists(orgA, gone)).toBe(false);
    expect(exists(orgA, keep)).toBe(true);
    expect(await count('SELECT 1 FROM export_packages WHERE id=$1', [oldEx])).toBe(1); // manifest row kept
    expect(await count('SELECT 1 FROM blobs WHERE org_id=$1 AND sha256=$2', [orgA, gone])).toBe(0);
    expect((await purgeExpired(db, store, { orgId: orgA })).export_zips_deleted).toBe(0);
  });

  it('the purge job handler runs one pass for its org and reports ids and counts only', async () => {
    const proj = uuidv7();
    await db.query("INSERT INTO projects(id,org_id,name,deleted_at) VALUES ($1,$2,'x', now() - interval '10 days')", [proj, orgA]);
    const checkpoints: unknown[] = [];
    const env = { db, store } as unknown as WorkerEnv;
    await purgeHandler(env, { id: uuidv7(), org_id: orgA, project_id: null, kind: 'purge', subject_type: null, subject_id: null, payload: {}, status: 'running', attempt: 1, max_attempts: 3, lease_owner: 'w', cancel_requested_at: null }, { checkpoint: async (p) => { checkpoints.push(p); } });
    expect(await count('SELECT 1 FROM projects WHERE id=$1', [proj])).toBe(0);
    expect(JSON.stringify(checkpoints)).toContain('"projects":1');
  });
});
