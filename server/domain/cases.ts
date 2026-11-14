import { PolicyRules, type CaseInput } from '@lb/contracts';
import { COMPARE_ENGINE_VERSION } from '@lb/compare';
import { uuidv7 } from '../db/ids';
import { enqueue } from '../jobs/queue';
import { digest } from './canonical';
import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { getHeads, moveHead, nextNumber } from './projects';
import { safePath } from './sources';
import { putBlob } from '../storage/blobs';

export interface CaseSpec {
  argv?: string[]; env?: Record<string, string>; timeout_ms?: number;
  stdin?: { text?: string; base64?: string };
  files?: { path: string; text?: string; base64?: string; mode?: string }[];
}

/** Stores stdin and files as blobs and produces the canonical CaseInput used by both original and replacement. */
export async function createTestCase(c: Ctx, projectId: string, name: string, spec: CaseSpec, origin: 'user' | 'template' | 'imported' = 'user') {
  await getHeads(c.db, c.orgId, projectId);
  let stdin_blob: string | null = null;
  if (spec.stdin) stdin_blob = (await putBlob(c.db, c.store, c.orgId, spec.stdin.base64 !== undefined ? Buffer.from(spec.stdin.base64, 'base64') : Buffer.from(spec.stdin.text ?? ''))).sha256;
  const files: CaseInput['files'] = [];
  for (const f of spec.files ?? []) {
    safePath(f.path);
    const b = await putBlob(c.db, c.store, c.orgId, f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? ''));
    files.push({ path: f.path, blob: b.sha256, mode: f.mode ?? '0644' });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const input: CaseInput = { argv: spec.argv ?? [], env: spec.env ?? {}, stdin_blob, files, timeout_ms: Math.min(spec.timeout_ms ?? 10_000, 60_000) };
  const input_digest = digest(input);
  const existing = await c.db.query<{ id: string }>('SELECT id FROM test_cases WHERE project_id=$1 AND org_id=$2 AND input_digest=$3', [projectId, c.orgId, input_digest]);
  if (existing[0]) return { id: existing[0].id, input_digest, reused: true };
  const id = uuidv7();
  await c.db.query('INSERT INTO test_cases(id,org_id,project_id,name,input,input_digest,origin,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, c.orgId, projectId, name, JSON.stringify(input), input_digest, origin, c.userId]);
  return { id, input_digest, reused: false };
}

export async function createPolicy(c: Ctx, projectId: string, rulesIn: unknown) {
  const heads = await getHeads(c.db, c.orgId, projectId);
  const parsed = PolicyRules.safeParse(rulesIn ?? { engine: COMPARE_ENGINE_VERSION });
  if (!parsed.success) throw new DomainError('invalid_policy', 422, parsed.error.message);
  if (parsed.data.engine !== COMPARE_ENGINE_VERSION) throw new DomainError('engine_mismatch', 422, `Compare engine is ${COMPARE_ENGINE_VERSION}`);
  return c.db.tx(async (t) => {
    const id = uuidv7();
    const d = digest(parsed.data);
    await t.query('INSERT INTO comparison_policies(id,org_id,project_id,number,parent_id,rules,digest,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, c.orgId, projectId, await nextNumber(t, 'comparison_policies', projectId), heads.current_policy_id, JSON.stringify(parsed.data), d, c.userId]);
    await moveHead(t, c.orgId, projectId, 'current_policy_id', id, heads.heads_version);
    return { id, digest: d };
  });
}

export interface CaseSetEntry { test_case_id: string; reference_output_id: string | null }

export async function createCaseSet(c: Ctx, projectId: string, entries: CaseSetEntry[]) {
  const heads = await getHeads(c.db, c.orgId, projectId);
  if (!entries.length || entries.length > 500) throw new DomainError('invalid_request', 422, '1 to 500 cases required');
  if (new Set(entries.map((e) => e.test_case_id)).size !== entries.length) throw new DomainError('duplicate_case', 422);
  for (const e of entries) {
    const tc = await c.db.query('SELECT 1 FROM test_cases WHERE id=$1 AND org_id=$2 AND project_id=$3', [e.test_case_id, c.orgId, projectId]);
    if (!tc.length) throw new DomainError('not_found', 404, 'test case');
    if (e.reference_output_id) {
      const r = await c.db.query('SELECT 1 FROM reference_outputs WHERE id=$1 AND org_id=$2 AND test_case_id=$3', [e.reference_output_id, c.orgId, e.test_case_id]);
      if (!r.length) throw new DomainError('not_found', 404, 'reference output');
    }
  }
  return c.db.tx(async (t) => {
    const id = uuidv7();
    const d = digest(entries);
    await t.query('INSERT INTO case_set_revisions(id,org_id,project_id,number,parent_id,entries,digest,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, c.orgId, projectId, await nextNumber(t, 'case_set_revisions', projectId), heads.current_case_set_revision_id, JSON.stringify(entries), d, c.userId]);
    await moveHead(t, c.orgId, projectId, 'current_case_set_revision_id', id, heads.heads_version);
    return { id, digest: d };
  });
}

/** User-supplied reference: needs an attestation and is always displayed as such. */
export async function supplyReference(c: Ctx, testCaseId: string, observation: { exit: { code: number | null; signal: string | null }; stdout?: { text?: string; base64?: string }; stderr?: { text?: string; base64?: string } }, attestation: string) {
  if (!attestation?.trim()) throw new DomainError('attestation_required', 422);
  const tc = await c.db.query('SELECT 1 FROM test_cases WHERE id=$1 AND org_id=$2', [testCaseId, c.orgId]);
  if (!tc.length) throw new DomainError('not_found', 404);
  const chan = async (x?: { text?: string; base64?: string }) => {
    const buf = x?.base64 !== undefined ? Buffer.from(x.base64, 'base64') : Buffer.from(x?.text ?? '');
    const b = await putBlob(c.db, c.store, c.orgId, buf);
    return { sha256: b.sha256, size: b.size, blob: b.sha256 };
  };
  const obs = { exit: observation.exit, stdout: await chan(observation.stdout), stderr: await chan(observation.stderr), files: [], truncated: { stdout: false, stderr: false, files: false }, complete: true };
  const id = uuidv7();
  await c.db.query(`INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,observation,attestation,supplied_by) VALUES ($1,$2,$3,'user_supplied',$4,$5,$6)`, [id, c.orgId, testCaseId, JSON.stringify(obs), attestation, c.userId]);
  await c.db.query(`INSERT INTO events(org_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,'reference.supplied','reference_output',$3)`, [c.orgId, c.userId, id]);
  return { id };
}

/** Enforces invariant 10 (execution enabled + per-revision consent) before running any original executable. */
async function assertExecutionPermitted(c: Ctx, projectId: string, sourceId: string, environmentId: string) {
  await getHeads(c.db, c.orgId, projectId);
  const org = (await c.db.query<{ execution_enabled: boolean }>('SELECT execution_enabled FROM organizations WHERE id=$1', [c.orgId]))[0];
  if (!org.execution_enabled) throw new DomainError('execution_not_permitted', 409, 'This organization has not enabled running uploaded executables.', { kind: 'enable_setting', setting: 'execution_enabled', role_required: 'admin' });
  const src = await c.db.query<{ execution_consent_at: string | null }>('SELECT execution_consent_at FROM source_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3', [sourceId, c.orgId, projectId]);
  if (!src[0]) throw new DomainError('not_found', 404);
  if (!src[0].execution_consent_at) throw new DomainError('execution_consent_required', 409, 'Acknowledge execution consent for this source revision first.', { kind: 'execution_consent', source_revision_id: sourceId });
  const env = await c.db.query("SELECT 1 FROM execution_environments WHERE id=$1 AND role='original'", [environmentId]);
  if (!env.length) throw new DomainError('not_found', 404, 'environment');
}

export async function requestCapture(c: Ctx, projectId: string, i: { source_revision_id: string; environment_id: string; test_case_ids: string[]; repeat?: number }) {
  await assertExecutionPermitted(c, projectId, i.source_revision_id, i.environment_id);
  for (const id of i.test_case_ids) {
    if (!(await c.db.query('SELECT 1 FROM test_cases WHERE id=$1 AND org_id=$2 AND project_id=$3', [id, c.orgId, projectId])).length) throw new DomainError('not_found', 404, 'test case');
  }
  const job = await enqueue(c.db, { orgId: c.orgId, projectId, kind: 'capture', subjectType: 'source_revision', subjectId: i.source_revision_id, payload: { ...i, repeat: Math.min(Math.max(i.repeat ?? 2, 1), 5) }, dedupeKey: `capture:${i.source_revision_id}:${digest([...i.test_case_ids].sort())}` });
  return { job_id: job.id };
}

export async function requestProbe(c: Ctx, projectId: string, i: { source_revision_id: string; environment_id: string; argv?: string[]; stdin_text?: string }) {
  await assertExecutionPermitted(c, projectId, i.source_revision_id, i.environment_id);
  const job = await enqueue(c.db, { orgId: c.orgId, projectId, kind: 'probe', subjectType: 'source_revision', subjectId: i.source_revision_id, payload: { ...i }, dedupeKey: `probe:${i.source_revision_id}` });
  return { job_id: job.id };
}
