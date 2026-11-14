import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';

let db: Db;
const org = uuidv7(), proj = uuidv7();
beforeAll(async () => {
  db = await testDb();
  await db.query("INSERT INTO organizations(id,name) VALUES ($1,'a')", [org]);
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'p')", [proj, org]);
});

describe('migrations + immutability', () => {
  it('rejects UPDATE/DELETE on immutable tables', async () => {
    const id = uuidv7();
    await db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin) VALUES ($1,$2,$3,'t','{}','d','user')", [id, org, proj]);
    await expect(db.query("UPDATE test_cases SET name='x' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM test_cases WHERE id=$1', [id])).rejects.toThrow(/immutable/);
  });
  it('cross-org composite FK blocks a child pointing at another org parent', async () => {
    const org2 = uuidv7();
    await db.query("INSERT INTO organizations(id,name) VALUES ($1,'b')", [org2]);
    await expect(db.query("INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin) VALUES ($1,$2,$3,'t','{}','d2','user')", [uuidv7(), org2, proj])).rejects.toThrow(/foreign key/);
  });
  it('reference outputs need provenance fields; match needs a reference', async () => {
    const tc = (await db.query<{ id: string }>('SELECT id FROM test_cases LIMIT 1'))[0].id;
    await expect(db.query("INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation) VALUES ($1,$2,$3,'captured_original','{}')", [uuidv7(), org, tc])).rejects.toThrow(/captured_needs_source/);
    await expect(db.query("INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation) VALUES ($1,$2,$3,'user_supplied','{}')", [uuidv7(), org, tc])).rejects.toThrow(/supplied_needs_attestation/);
    await expect(db.query("INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation) VALUES ($1,$2,$3,'replacement','{}')", [uuidv7(), org, tc])).rejects.toThrow(/check/);
  });
  it('source revision allows only set-once consent', async () => {
    const sr = uuidv7();
    await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [sr, org, proj]);
    await db.query("UPDATE source_revisions SET execution_consent_at=now() WHERE id=$1", [sr]);
    await expect(db.query("UPDATE source_revisions SET execution_consent_at=now() + interval '1 day' WHERE id=$1", [sr])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE source_revisions SET notes='x' WHERE id=$1", [sr])).rejects.toThrow(/immutable/);
  });
  it('analysis run finalizes once', async () => {
    const sr = (await db.query<{ id: string }>('SELECT id FROM source_revisions LIMIT 1'))[0].id;
    const id = uuidv7();
    await db.query("INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,kind,provider,params_digest) VALUES ($1,$2,$3,$4,'inspect','builtin-elf','x')", [id, org, proj, sr]);
    await db.query("UPDATE analysis_runs SET outcome='complete' WHERE id=$1", [id]);
    await expect(db.query("UPDATE analysis_runs SET outcome='failed' WHERE id=$1", [id])).rejects.toThrow(/already finalized/);
  });
  it('exactly one primary executable per revision', async () => {
    const sr = (await db.query<{ id: string }>('SELECT id FROM source_revisions LIMIT 1'))[0].id;
    await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k')", [org, 'a'.repeat(64)]);
    const ins = (p: string) => db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,$3,'primary_executable',$4,1)", [sr, org, p, 'a'.repeat(64)]);
    await ins('a');
    await expect(ins('b')).rejects.toThrow(/unique/);
  });
});
