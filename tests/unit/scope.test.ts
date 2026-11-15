/**
 * S3 scope editing and approvals: lineage, approval preconditions, re-approval staleness, progress after a re-import, and the read model.
 * Concurrency is exercised with Promise.allSettled on PGlite, which has a single connection: it proves the unique-constraint outcome
 * (exactly one winner), not true multi-connection interleaving. Run with TEST_DATABASE_URL for that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import type { Ctx } from '../../server/domain/ctx';
import { createScopeRevision, decideScope, getHeads, moveHead, putScopeDraft } from '../../server/domain/projects';
import { getScopeRevision, listScopeRevisions } from '../../server/domain/scope';
import { getProgress } from '../../server/domain/queries';
import { appliesToCurrent } from '../../server/domain/verification';

let db: Db, c: Ctx;
const org = uuidv7(), other = uuidv7(), user = uuidv7(), proj = uuidv7(), src1 = uuidv7(), src2 = uuidv7();
const behavior = (id: string, evidence: string[] = []) => ({ id, statement: `Does ${id}`, basis: 'observed', evidence });
const doc = (extra: Record<string, unknown> = {}) => ({ workflow: { name: 'w', invocation: { argv_template: [] } }, interface: { language: 'typescript' }, behaviors: [behavior('a')], ...extra });
const approve = (id: string, sha: string) => decideScope(db, org, proj, id, 'approved', sha, user);
let version = 0;
async function draft(document: unknown, base?: string | null) { version = await putScopeDraft(db, org, proj, document, version, user, base); return version; }

const inspected = (source: string) => db.query("INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,kind,provider,params_digest,outcome,eligibility,facts) VALUES ($1,$2,$3,$4,'inspect','builtin','d','complete',$5,'{}')",
  [uuidv7(), org, proj, source, JSON.stringify({ analysis: 'eligible', execution: 'unknown', reasons: [] })]);

beforeAll(async () => {
  db = await testDb();
  c = { db, orgId: org, userId: user, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'scope-blobs-'))) };
  for (const o of [org, other]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'s@x')", [user]);
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [proj, org]);
  for (const [i, id] of [src1, src2].entries()) await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,$4,'m')", [id, org, proj, i + 1]);
  await moveHead(db, org, proj, 'current_source_revision_id', src1, (await getHeads(db, org, proj)).heads_version);
  await inspected(src1);
});

describe('S3 scope revisions', () => {
  let r1: { id: string; document_sha256: string }, r2: { id: string; document_sha256: string };

  it('an empty scope can be saved and sealed but not approved', async () => {
    await draft(doc({ behaviors: [] }));
    const empty = await createScopeRevision(db, org, proj, version, user);
    await expect(approve(empty.id, empty.document_sha256)).rejects.toMatchObject({ code: 'scope_empty', status: 422 });
    expect((await getHeads(db, org, proj)).approved_scope_revision_id).toBeNull();
  });

  it('rejection needs a comment, is recorded, and leaves the approved head alone', async () => {
    await draft(doc({ assumptions: [{ id: 'as1', text: 'Input is ASCII' }], open_questions: [{ id: 'q1', text: 'Max input size?', status: 'open' }] }));
    r1 = await createScopeRevision(db, org, proj, version, user);
    await expect(decideScope(db, org, proj, r1.id, 'rejected', r1.document_sha256, user)).rejects.toMatchObject({ code: 'comment_required' });
    await decideScope(db, org, proj, r1.id, 'rejected', r1.document_sha256, user, 'Needs the size limit');
    expect(await getScopeRevision(c, r1.id)).toMatchObject({ status: 'rejected', decision: { decision: 'rejected', comment: 'Needs the size limit', decided_by: user }, is_approved_head: false });
    await expect(approve(r1.id, r1.document_sha256)).rejects.toMatchObject({ code: 'already_decided' });
  });

  it('lineage: the draft remembers its base and the next revision descends from it', async () => {
    expect((await db.query<{ base_revision_id: string }>('SELECT base_revision_id FROM scope_drafts WHERE project_id=$1', [proj]))[0].base_revision_id).toBe(r1.id);
    await draft(doc({ open_questions: [{ id: 'q1', text: 'Max input size?', status: 'resolved', resolution: '1 MiB' }] }));
    r2 = await createScopeRevision(db, org, proj, version, user);
    expect(await getScopeRevision(c, r2.id)).toMatchObject({ number: 3, parent_id: r1.id, status: 'pending', counts: { open_questions: 0, assumptions: 0, behaviors: 1 } });
    await expect(draft(doc(), uuidv7())).rejects.toMatchObject({ status: 404 }); // base must be one of this project's revisions
  });

  it('two simultaneous approvals of one revision: exactly one wins, the other gets 409', async () => {
    const results = await Promise.allSettled([approve(r2.id, r2.document_sha256), approve(r2.id, r2.document_sha256)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'already_decided', status: 409 });
    expect((await getHeads(db, org, proj)).approved_scope_revision_id).toBe(r2.id);
  });

  it('read model: list shows status and head; get hydrates cited findings', async () => {
    const list = await listScopeRevisions(c, proj);
    expect(list.approved_scope_revision_id).toBe(r2.id);
    expect(list.items.map((i) => [i.number, i.status, i.is_approved_head])).toEqual([[3, 'approved', true], [2, 'rejected', false], [1, 'pending', false]]);
    await expect(getScopeRevision({ ...c, orgId: other }, r2.id)).rejects.toMatchObject({ status: 404 });
    await expect(listScopeRevisions({ ...c, orgId: other }, proj)).rejects.toMatchObject({ status: 404 });
  });

  it('re-approval makes a run bound to the earlier scope stale (scope_reapproved)', async () => {
    const [mod, build, cs, pol, env, run] = Array.from({ length: 6 }, () => uuidv7());
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [org, 'c'.repeat(64)]);
    await db.query("INSERT INTO module_revisions(id,org_id,project_id,number,scope_revision_id,origin,source_tree_blob_sha256,tree_sha256,file_manifest) VALUES ($1,$2,$3,1,$4,'customer_upload',$5,'t','[]')", [mod, org, proj, r2.id, 'c'.repeat(64)]);
    await db.query("INSERT INTO build_results(id,org_id,module_revision_id,attempt,build_image_digest,status) VALUES ($1,$2,$3,1,'img','succeeded')", [build, org, mod]);
    await db.query("INSERT INTO case_set_revisions(id,org_id,project_id,number,entries,digest) VALUES ($1,$2,$3,1,'[]','d')", [cs, org, proj]);
    await db.query("INSERT INTO comparison_policies(id,org_id,project_id,number,rules,digest) VALUES ($1,$2,$3,1,'{}','d')", [pol, org, proj]);
    await db.query("INSERT INTO execution_environments(id,name,version,role,image_digest,arch) VALUES ($1,'n',1,'replacement','i','x86-64')", [env]);
    await db.query(`INSERT INTO verification_runs(id,org_id,project_id,source_revision_id,scope_revision_id,module_revision_id,build_result_id,case_set_revision_id,comparison_policy_id,replacement_env_id,binding,binding_digest,completeness)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}','bd','complete')`, [run, org, proj, src1, r2.id, mod, build, cs, pol, env]);
    let h = await getHeads(db, org, proj);
    for (const [head, id] of [['current_module_revision_id', mod], ['current_case_set_revision_id', cs], ['current_policy_id', pol]] as const) { await moveHead(db, org, proj, head, id, h.heads_version); h = await getHeads(db, org, proj); }
    expect(await appliesToCurrent(db, org, proj, run)).toEqual({ applies_to_current: true, stale_reasons: [] });
    expect((await getProgress(c, proj)).needs_input.map((n) => n.code)).not.toContain('module_scope_outdated');

    await draft(doc({ behaviors: [behavior('a'), behavior('b')] }), r2.id);
    const r3 = await createScopeRevision(db, org, proj, version, user);
    await approve(r3.id, r3.document_sha256);
    expect(await appliesToCurrent(db, org, proj, run)).toEqual({ applies_to_current: false, stale_reasons: ['scope_reapproved'] });
    // The module was built against the earlier scope, so Modernize is no longer complete.
    expect(await getProgress(c, proj)).toMatchObject({ completed_steps: 2, needs_input: expect.arrayContaining([{ step: 'modernize', code: 'module_scope_outdated' }]) });
  });

  it('after a re-import the old approval no longer counts, and a scope for the old source cannot be approved', async () => {
    const before = await getHeads(db, org, proj);
    await draft(doc({ behaviors: [behavior('a'), behavior('b'), behavior('c')] }));
    const stale = await createScopeRevision(db, org, proj, version, user); // sealed against src1
    await moveHead(db, org, proj, 'current_source_revision_id', src2, before.heads_version);
    await inspected(src2);
    const progress = await getProgress(c, proj);
    expect(progress.completed_steps).toBe(1);
    expect(progress.needs_input).toContainEqual({ step: 'select', code: 'scope_source_changed' });
    await expect(approve(stale.id, stale.document_sha256)).rejects.toMatchObject({ code: 'scope_source_changed', status: 409 });
    expect((await listScopeRevisions(c, proj)).items.find((i) => i.id === stale.id)?.source_is_current).toBe(false);
  });
});
