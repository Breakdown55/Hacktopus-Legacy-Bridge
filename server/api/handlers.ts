import { z } from 'zod';
import { ScopeDocV1 } from '@lb/contracts';
import { uuidv7 } from '../db/ids';
import { FINDING_KINDS, getFinding, getRawEvidence, listCandidates, listFindings, listNativeRuns, queueNativeAnalysis } from '../domain/analysis';
import { cancel } from '../jobs/queue';
import { createCaseSet, createPolicy, createTestCase, requestCapture, requestProbe, supplyReference } from '../domain/cases';
import { DomainError } from '../domain/errors';
import { createExport, getExport } from '../domain/exports';
import { createModuleRevision, getModuleFiles } from '../domain/modules';
import { createScopeRevision, decideScope, getHeads, putScopeDraft } from '../domain/projects';
import { getScopeRevision, listScopeRevisions } from '../domain/scope';
import { requestGeneration } from '../domain/generation';
import { getActivity, getJob, getModule, getProject, getVerificationRun, listBuilds, listProjects, listResults } from '../domain/queries';
import { completeUpload, createUpload, getSourceStatus, recordExecutionConsent, sealSourceRevision } from '../domain/sources';
import { createVerificationRun } from '../domain/verification';
import { decodeCursor, pageLimit, problem, route } from '../http/handler';
import type { Ctx } from '../domain/ctx';

type P = Record<string, string>;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f-]{36}$/);
const text = z.object({ text: z.string().optional(), base64: z.string().optional() });
const analysisRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('index') }),
  z.object({ kind: z.literal('deep_function'), params: z.object({ address: z.string().max(32) }) }),
]);

/** 404 (never 403) when an entity does not belong to the caller's org. */
async function projectOf(c: Ctx, table: string, id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new DomainError('not_found', 404);
  const r = await c.db.query<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id=$1 AND org_id=$2`, [id, c.orgId]);
  if (!r[0]) throw new DomainError('not_found', 404);
  return r[0].project_id;
}
const pid = async (c: Ctx, id: string) => { await getHeads(c.db, c.orgId, id); return id; };

export const api = {
  projectsList: route({ role: 'viewer' }, async ({ ctx, url }) => ({ body: await listProjects(ctx, pageLimit(url), url.searchParams.get('cursor')) })),
  projectsCreate: route({ role: 'editor', idempotent: true, body: z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).default(''), objectives: z.string().max(5000).default('') }) }, async ({ ctx, body }) => {
    const n = (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM projects WHERE org_id=$1 AND deleted_at IS NULL', [ctx.orgId]))[0].n;
    if (n >= 50) throw new DomainError('quota_exceeded', 429, 'Project limit reached (50)');
    const id = uuidv7();
    await ctx.db.query('INSERT INTO projects(id,org_id,name,description,objectives,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, ctx.orgId, body.name, body.description, body.objectives, ctx.userId]);
    await ctx.db.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'project.created','project',$2::uuid::text)`, [ctx.orgId, id, ctx.userId]);
    return { status: 201, body: await getProject(ctx, id) };
  }),
  projectGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getProject(ctx, await pid(ctx, params.pid)) })),
  projectDelete: route<P>({ role: 'admin' }, async ({ ctx, params }) => {
    await getHeads(ctx.db, ctx.orgId, params.pid);
    await ctx.db.tx(async (t) => {
      await t.query('UPDATE projects SET deleted_at=now() WHERE id=$1 AND org_id=$2', [params.pid, ctx.orgId]);
      await t.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE project_id=$1 AND org_id=$2 AND status='queued'`, [params.pid, ctx.orgId]);
      await t.query(`UPDATE jobs SET cancel_requested_at=now() WHERE project_id=$1 AND org_id=$2 AND status='running'`, [params.pid, ctx.orgId]);
      await t.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'project.deleted','project',$2::uuid::text)`, [ctx.orgId, params.pid, ctx.userId]);
    });
    return { status: 204 };
  }),

  uploadCreate: route<P, { filename: string; size: number; sha256: string }>({ role: 'editor', idempotent: true, body: z.object({ filename: z.string().min(1).max(255), size: z.number().int().min(0), sha256: sha }) }, async ({ ctx, params, body }) => ({ status: 201, body: await createUpload(ctx, params.pid, body) })),
  uploadComplete: route<P>({ role: 'editor' }, async ({ ctx, params }) => ({ body: await completeUpload(ctx, params.uid) })),
  sourceCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ parent_id: uuid.nullable().optional(), artifacts: z.array(z.object({ upload_id: uuid, path: z.string(), role: z.string() })), notes: z.string().max(5000).optional(), objectives: z.string().max(5000).optional() }) }, async ({ ctx, params, body }) => ({ status: 201, body: await sealSourceRevision(ctx, params.pid, body) })),
  sourceGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getSourceStatus(ctx, params.sid) })),
  sourceConsent: route<P, { acknowledge: string }>({ role: 'editor', body: z.object({ acknowledge: z.string() }) }, async ({ ctx, params, body }) => { await recordExecutionConsent(ctx, params.sid, body.acknowledge); return { body: { consented: true } }; }),
  sourceProbe: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ environment_id: uuid, argv: z.array(z.string()).optional(), stdin_text: z.string().optional() }) }, async ({ ctx, params, body }) => ({ status: 202, body: await requestProbe(ctx, await projectOf(ctx, 'source_revisions', params.sid), { ...body, source_revision_id: params.sid }) })),
  analysisRunCreate: route<P, z.infer<typeof analysisRequest>>({ role: 'editor', idempotent: true, body: analysisRequest }, async ({ ctx, params, body }) => ({ status: 202, body: await queueNativeAnalysis(ctx, params.sid, body) })),
  analysisRunsList: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await listNativeRuns(ctx, params.sid) })),
  findingsList: route<P>({ role: 'viewer' }, async ({ ctx, params, url }) => {
    const q = url.searchParams.get('q') ?? '';
    const cursor = url.searchParams.get('cursor') || undefined;
    const kind = z.enum(FINDING_KINDS).optional().parse(url.searchParams.get('kind') || undefined);
    if (q.length > 200 || q.includes('\0') || (cursor?.length ?? 0) > 2048) throw new DomainError('invalid_query', 400);
    return { body: await listFindings(ctx, params.sid, { kind, q, cursor, limit: Math.floor(pageLimit(url)), runId: url.searchParams.get('run_id') || undefined }) };
  }),
  findingGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getFinding(ctx, params.fid) })),
  candidatesList: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await listCandidates(ctx, params.sid) })),
  rawEvidenceGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => new Response(await getRawEvidence(ctx, params.rid, params.eid), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })),

  scopeDraftGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => {
    await getHeads(ctx.db, ctx.orgId, params.pid);
    const d = (await ctx.db.query<{ version: number; base_revision_id: string | null; document: unknown }>('SELECT version, base_revision_id, document FROM scope_drafts WHERE project_id=$1 AND org_id=$2', [params.pid, ctx.orgId]))[0];
    const v = d?.version ?? 0;
    return { body: { version: v, base_revision_id: d?.base_revision_id ?? null, document: d?.document ?? null }, headers: { etag: `"v${v}"` } };
  }),
  scopeDraftPut: route<P, { document: unknown; base_revision_id?: string | null }>({ role: 'editor', body: z.object({ document: z.unknown(), base_revision_id: uuid.nullable().optional() }) }, async ({ ctx, req, params, body }) => {
    const m = /^"?v(\d+)"?$/.exec(req.headers.get('if-match') ?? '');
    if (!m) throw new DomainError('precondition_required', 428, 'If-Match: "v<version>" is required (use "v0" to create)');
    const parsed = ScopeDocV1.safeParse(body.document);
    if (!parsed.success) return problem(422, 'validation_failed', 'Validation failed', { fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) });
    const v = await putScopeDraft(ctx.db, ctx.orgId, params.pid, body.document, Number(m[1]), ctx.userId, body.base_revision_id);
    return { body: { version: v, document: body.document }, headers: { etag: `"v${v}"` } };
  }),
  scopeRevisionsList: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await listScopeRevisions(ctx, params.pid) })),
  scopeRevisionGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getScopeRevision(ctx, params.rid) })),
  scopeRevisionCreate: route<P, { from_draft_version: number }>({ role: 'editor', idempotent: true, body: z.object({ from_draft_version: z.number().int().min(1) }) }, async ({ ctx, params, body }) => ({ status: 201, body: await createScopeRevision(ctx.db, ctx.orgId, params.pid, body.from_draft_version, ctx.userId) })),
  scopeDecision: route<P, { decision: 'approved' | 'rejected'; document_sha256: string; comment?: string }>({ role: 'editor', body: z.object({ decision: z.enum(['approved', 'rejected']), document_sha256: sha, comment: z.string().max(2000).optional() }) }, async ({ ctx, params, body }) => ({ body: await decideScope(ctx.db, ctx.orgId, await projectOf(ctx, 'scope_revisions', params.rid), params.rid, body.decision, body.document_sha256, ctx.userId!, body.comment) })),

  moduleCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ origin: z.enum(['user_edit', 'customer_upload', 'generated']), instructions: z.string().max(2000).optional(), scope_revision_id: uuid, parent_id: uuid.nullable().optional(), make_current: z.boolean().optional(), files: z.array(z.object({ path: z.string(), content: z.string() })).optional(), changes: z.array(z.object({ path: z.string(), content: z.string().optional(), delete: z.boolean().optional() })).optional() }) }, async ({ ctx, params, body }) => body.origin === 'generated'
    // Generation is a job: the worker creates the revision and then enqueues its build.
    ? { status: 202, body: await requestGeneration(ctx, params.pid, { scope_revision_id: body.scope_revision_id, parent_id: body.parent_id, instructions: body.instructions }) }
    : { status: 201, body: await createModuleRevision(ctx, params.pid, body) }),
  moduleGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getModule(ctx, params.mid) })),
  moduleBuilds: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await listBuilds(ctx, params.mid) })),
  moduleFile: route<P>({ role: 'viewer' }, async ({ ctx, params, url }) => {
    const path = decodeURIComponent(url.pathname.split('/files/')[1] ?? '');
    const f = (await getModuleFiles(ctx, params.mid)).find((x) => x.path === path);
    if (!f) throw new DomainError('not_found', 404);
    return { body: { path, encoding: 'utf-8', content: f.content } };
  }),

  testCaseCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ name: z.string().min(1).max(200), input: z.object({ argv: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), timeout_ms: z.number().int().optional(), stdin: text.optional(), files: z.array(z.object({ path: z.string(), text: z.string().optional(), base64: z.string().optional(), mode: z.string().optional() })).optional() }) }) }, async ({ ctx, params, body }) => {
    const r = await createTestCase(ctx, params.pid, body.name, body.input);
    return { status: r.reused ? 200 : 201, body: r };
  }),
  referenceCapture: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ source_revision_id: uuid, environment_id: uuid, test_case_ids: z.array(uuid).min(1).max(500), repeat: z.number().int().min(1).max(5).optional() }) }, async ({ ctx, params, body }) => ({ status: 202, body: await requestCapture(ctx, params.pid, body) })),
  referenceSupply: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ provenance: z.literal('user_supplied'), observation: z.object({ exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }), stdout: text.optional(), stderr: text.optional() }), attestation: z.string().min(1) }) }, async ({ ctx, params, body }) => ({ status: 201, body: await supplyReference(ctx, params.tcid, body.observation, body.attestation) })),
  caseSetCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ set: z.array(z.object({ test_case_id: uuid, reference_output_id: uuid.nullable() })) }) }, async ({ ctx, params, body }) => ({ status: 201, body: await createCaseSet(ctx, params.pid, body.set) })),
  policyCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ rules: z.unknown().optional() }) }, async ({ ctx, params, body }) => ({ status: 201, body: await createPolicy(ctx, params.pid, body.rules ?? null) })),

  verificationCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ environment_id: uuid, module_revision_id: uuid.optional(), case_set_revision_id: uuid.optional(), comparison_policy_id: uuid.optional() }) }, async ({ ctx, params, body }) => { const r = await createVerificationRun(ctx, params.pid, body); return { status: 202, body: r }; }),
  verificationGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getVerificationRun(ctx, params.vrid) })),
  verificationResults: route<P>({ role: 'viewer' }, async ({ ctx, params, url }) => ({ body: await listResults(ctx, params.vrid, url.searchParams.get('outcome'), pageLimit(url), url.searchParams.get('cursor')) })),

  exportCreate: route<P, any>({ role: 'editor', idempotent: true, body: z.object({ verification_run_id: uuid, include_original_binary: z.boolean().optional(), allow_partial: z.boolean().optional() }) }, async ({ ctx, params, body }) => ({ status: 202, body: await createExport(ctx, params.pid, body) })),
  exportGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getExport(ctx, params.eid) })),
  exportDownload: route<P>({ role: 'viewer' }, async ({ ctx, params }) => {
    const e = (await ctx.db.query<{ package_blob_sha256: string | null; expires_at: string; project_id: string }>('SELECT package_blob_sha256, expires_at, project_id FROM export_packages WHERE id=$1 AND org_id=$2', [params.eid, ctx.orgId]))[0];
    if (!e) throw new DomainError('not_found', 404);
    if (!e.package_blob_sha256) throw new DomainError('export_not_ready', 409);
    if (new Date(e.expires_at) < new Date()) throw new DomainError('export_expired', 410, 'The package expired; rebuild it from the same verification run.');
    await ctx.db.query(`INSERT INTO events(org_id,project_id,actor_id,type,subject_type,subject_id) VALUES ($1,$2,$3,'export.downloaded','export',$4)`, [ctx.orgId, e.project_id, ctx.userId, params.eid]);
    return new Response(null, { status: 302, headers: { location: await ctx.store.presignGet(ctx.orgId, e.package_blob_sha256, `legacy-bridge-export-${params.eid.slice(-8)}.zip`) } });
  }),

  jobGet: route<P>({ role: 'viewer' }, async ({ ctx, params }) => ({ body: await getJob(ctx, params.jid) })),
  jobCancel: route<P>({ role: 'editor' }, async ({ ctx, params }) => {
    await getJob(ctx, params.jid); // 404 for jobs outside the caller's org
    const r = await cancel(ctx.db, ctx.orgId, params.jid);
    if (r === 'noop') throw new DomainError('not_cancellable', 409);
    return { status: 202, body: { status: r } };
  }),
  activity: route<P>({ role: 'viewer' }, async ({ ctx, params, url }) => ({ body: await getActivity(ctx, params.pid, Number((url.searchParams.get('after') ?? 'evt_0').replace('evt_', '')) || 0, pageLimit(url)) })),

  /** A blob is downloadable only if this project references it. Always attachment + octet-stream; never rendered inline. */
  blobGet: route<P>({ role: 'viewer' }, async ({ ctx, params, url }) => {
    await getHeads(ctx.db, ctx.orgId, params.pid);
    if (!/^[0-9a-f]{64}$/.test(params.sha)) throw new DomainError('not_found', 404);
    const ref = await ctx.db.query(
      `SELECT 1 FROM blobs b WHERE b.org_id=$1 AND b.sha256=$2 AND (
         EXISTS (SELECT 1 FROM source_artifacts a JOIN source_revisions r ON r.id=a.source_revision_id WHERE r.project_id=$3 AND a.blob_sha256=$2)
         OR EXISTS (SELECT 1 FROM module_revisions m WHERE m.project_id=$3 AND (m.source_tree_blob_sha256=$2 OR m.file_manifest::text LIKE '%'||$2||'%'))
         OR EXISTS (SELECT 1 FROM test_cases t WHERE t.project_id=$3 AND t.input::text LIKE '%'||$2||'%')
         OR EXISTS (SELECT 1 FROM reference_outputs o JOIN test_cases t ON t.id=o.test_case_id WHERE t.project_id=$3 AND o.observation::text LIKE '%'||$2||'%')
         OR EXISTS (SELECT 1 FROM verification_results v JOIN verification_runs r ON r.id=v.verification_run_id WHERE r.project_id=$3 AND v.actual::text LIKE '%'||$2||'%')
         OR EXISTS (SELECT 1 FROM build_results br JOIN module_revisions m ON m.id=br.module_revision_id WHERE m.project_id=$3 AND (br.log_blob_sha256=$2 OR br.output_blob_sha256=$2))
         OR EXISTS (SELECT 1 FROM export_packages e WHERE e.project_id=$3 AND e.package_blob_sha256=$2))`, [ctx.orgId, params.sha, params.pid]);
    if (!ref.length) throw new DomainError('not_found', 404);
    const size = Number((await ctx.db.query<{ size_bytes: string }>('SELECT size_bytes FROM blobs WHERE org_id=$1 AND sha256=$2', [ctx.orgId, params.sha]))[0].size_bytes);
    if (url.searchParams.get('inline') === '1' && size <= 256 * 1024) {
      const buf = await ctx.store.get(ctx.orgId, params.sha);
      let utf8 = true; try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { utf8 = false; }
      return { body: { encoding: utf8 ? 'utf-8' : 'base64', content: utf8 ? buf.toString('utf8') : buf.toString('base64') } };
    }
    return new Response(null, { status: 302, headers: { location: await ctx.store.presignGet(ctx.orgId, params.sha, params.sha) } });
  }),
};
