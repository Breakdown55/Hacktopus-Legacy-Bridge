import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { canonical, digest } from '../../server/domain/canonical';
import { assertScopeApproved, createScopeRevision, decideScope, getHeads, moveHead, putScopeDraft } from '../../server/domain/projects';
import { appliesToCurrent, bindingDigest, finalizeRun, recordResult } from '../../server/domain/verification';

let db: Db;
const orgA = uuidv7(), orgB = uuidv7(), user = uuidv7(), proj = uuidv7(), src = uuidv7();
const doc = { workflow: { name: 'x' }, behaviors: [{ id: 'b', statement: 's', basis: 'observed' }] };

beforeAll(async () => {
  db = await testDb();
  for (const o of [orgA, orgB]) await db.query("INSERT INTO organizations(id,name) VALUES ($1,'o')", [o]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [proj, orgA]);
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, orgA, proj]);
  const h = await getHeads(db, orgA, proj);
  await moveHead(db, orgA, proj, 'current_source_revision_id', src, h.heads_version);
});

describe('canonical json / digest', () => {
  it('is key-order independent', () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });
  it('binding digest changes when any content digest changes', () => {
    const b = { source: { id: 's', manifest_sha256: 'a' }, scope: { id: 'c', sha256: 'a' }, module: { id: 'm', tree_sha256: 'a' }, build: { id: 'b', image: 'i' }, case_set: { id: 'cs', digest: 'a' }, policy: { id: 'p', digest: 'a' }, environment: { id: 'e', image: 'i' } };
    expect(bindingDigest(b)).toBe(bindingDigest(structuredClone(b)));
    expect(bindingDigest({ ...b, module: { id: 'm', tree_sha256: 'z' } })).not.toBe(bindingDigest(b));
  });
});

describe('tenant isolation', () => {
  it('another org gets 404 for the project', async () => {
    await expect(getHeads(db, orgB, proj)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(putScopeDraft(db, orgB, proj, doc, null, user)).rejects.toMatchObject({ status: 404 });
  });
});

describe('scope draft / revision / decision', () => {
  it('stale If-Match -> 412; matching -> version+1', async () => {
    expect(await putScopeDraft(db, orgA, proj, doc, null, user)).toBe(1);
    expect(await putScopeDraft(db, orgA, proj, { ...doc, v: 2 }, 1, user)).toBe(2);
    await expect(putScopeDraft(db, orgA, proj, doc, 1, user)).rejects.toMatchObject({ status: 412 });
  });
  it('revision from wrong draft version -> 412; digest mismatch -> 409; one decision only', async () => {
    await expect(createScopeRevision(db, orgA, proj, 1, user)).rejects.toMatchObject({ status: 412 });
    const rev = await createScopeRevision(db, orgA, proj, 2, user);
    await expect(assertScopeApproved(db, orgA, proj, rev.id)).rejects.toMatchObject({ code: 'scope_not_approved' });
    await expect(decideScope(db, orgA, proj, rev.id, 'approved', 'bad', user)).rejects.toMatchObject({ code: 'digest_mismatch' });
    const results = await Promise.allSettled([decideScope(db, orgA, proj, rev.id, 'approved', rev.document_sha256, user), decideScope(db, orgA, proj, rev.id, 'approved', rev.document_sha256, user)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'already_decided' });
    await assertScopeApproved(db, orgA, proj, rev.id);
    expect((await getHeads(db, orgA, proj)).approved_scope_revision_id).toBe(rev.id);
  });
  it('head CAS rejects a stale version', async () => {
    await expect(moveHead(db, orgA, proj, 'current_policy_id', uuidv7(), 0)).rejects.toMatchObject({ code: 'heads_conflict' });
  });
});

describe('verification runs', () => {
  const run = uuidv7(), tc = [uuidv7(), uuidv7()], mod = uuidv7(), cs = uuidv7(), pol = uuidv7(), build = uuidv7(), env = uuidv7(), ref = uuidv7();
  let scope: string;
  beforeAll(async () => {
    scope = (await getHeads(db, orgA, proj)).approved_scope_revision_id!;
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [orgA, 'b'.repeat(64)]);
    await db.query("INSERT INTO module_revisions(id,org_id,project_id,number,scope_revision_id,origin,source_tree_blob_sha256,tree_sha256,file_manifest) VALUES ($1,$2,$3,1,$4,'customer_upload',$5,'t','[]')", [mod, orgA, proj, scope, 'b'.repeat(64)]);
    await db.query("INSERT INTO build_results(id,org_id,module_revision_id,attempt,build_image_digest,status) VALUES ($1,$2,$3,1,'img','succeeded')", [build, orgA, mod]);
    await db.query("INSERT INTO case_set_revisions(id,org_id,project_id,number,entries,digest) VALUES ($1,$2,$3,1,'[]','d')", [cs, orgA, proj]);
    await db.query("INSERT INTO comparison_policies(id,org_id,project_id,number,rules,digest) VALUES ($1,$2,$3,1,'{}','d')", [pol, orgA, proj]);
    await db.query("INSERT INTO execution_environments(id,name,version,role,image_digest,arch) VALUES ($1,'n',1,'replacement','i','x86-64')", [env]);
    for (const t of tc) await db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin) VALUES ($1,$2,$3,'t','{}',$4,'user')", [t, orgA, proj, t]);
    await db.query("INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation,attestation,supplied_by) VALUES ($1,$2,$3,'user_supplied','{}','log',$4)", [ref, orgA, tc[0], user]);
    await db.query(`INSERT INTO verification_runs(id,org_id,project_id,source_revision_id,scope_revision_id,module_revision_id,build_result_id,case_set_revision_id,comparison_policy_id,replacement_env_id,binding,binding_digest)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}','bd')`, [run, orgA, proj, src, scope, mod, build, cs, pol, env]);
    let h = await getHeads(db, orgA, proj);
    for (const [head, id] of [['current_module_revision_id', mod], ['current_case_set_revision_id', cs], ['current_policy_id', pol]] as const) { await moveHead(db, orgA, proj, head, id, h.heads_version); h = await getHeads(db, orgA, proj); }
  });
  const rec = (tcId: string, outcome: string, referenceOutputId: string | null) => recordResult(db, { id: uuidv7(), orgId: orgA, runId: run, testCaseId: tcId, referenceOutputId, outcome, actual: {}, rawEqual: true, normalized: false, trace: [], differences: [], diagnostics: null, durationMs: 1 });

  it('applies to current while heads match', async () => {
    expect(await appliesToCurrent(db, orgA, proj, run)).toEqual({ applies_to_current: true, stale_reasons: [] });
  });
  it('match without a reference is rejected by the database', async () => {
    await expect(rec(tc[1], 'match', null)).rejects.toThrow(/match_needs_reference/);
  });
  it('result writes are insert-only: duplicate delivery is a no-op', async () => {
    expect(await rec(tc[0], 'match', ref)).toBe(true);
    expect(await rec(tc[0], 'difference', ref)).toBe(false);
    expect((await db.query<{ outcome: string }>('SELECT outcome FROM verification_results WHERE test_case_id=$1', [tc[0]]))[0].outcome).toBe('match');
  });
  it('partial until every case has a result; finalizes once', async () => {
    expect(await finalizeRun(db, orgA, run, 2)).toMatchObject({ completeness: 'partial', summary: { match: 1 } });
    expect(await finalizeRun(db, orgA, run, 2)).toBeNull();
  });
  it('a new module revision makes the run stale with module_revision_changed', async () => {
    const mod2 = uuidv7();
    await db.query("INSERT INTO module_revisions(id,org_id,project_id,number,parent_id,scope_revision_id,origin,source_tree_blob_sha256,tree_sha256,file_manifest) VALUES ($1,$2,$3,2,$4,$5,'user_edit',$6,'t2','[]')", [mod2, orgA, proj, mod, scope, 'b'.repeat(64)]);
    const h = await getHeads(db, orgA, proj);
    await moveHead(db, orgA, proj, 'current_module_revision_id', mod2, h.heads_version);
    expect(await appliesToCurrent(db, orgA, proj, run)).toEqual({ applies_to_current: false, stale_reasons: ['module_revision_changed'] });
  });
});
