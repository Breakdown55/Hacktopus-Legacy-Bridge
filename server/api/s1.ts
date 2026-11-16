import { getHeads, getProjectTarget } from '../domain/projects';
import { targetEnvironment } from '@lb/contracts';
import { getVerificationRun } from '../domain/queries';
import { getExport } from '../domain/exports';
import { problem, route } from '../http/handler';

function enabled(req: Request) {
  const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const host = new URL(req.url).hostname;
  let origin: URL | null = null;
  try { if (req.headers.get('origin')) origin = new URL(req.headers.get('origin')!); }
  catch { return false; }
  return process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_LB_S1_UI === '1'
    && process.env.LB_DEV_AUTH === '1' && local(host) && (!origin || local(origin.hostname))
    && req.headers.get('sec-fetch-site') !== 'cross-site';
}

export async function s1Config(req: Request) {
  if (!enabled(req)) return problem(404, 'not_found', 'Local S1 mode is disabled');
  if (!process.env.LB_S1_ORG_ID || !process.env.LB_S1_USER_ID) {
    return problem(503, 's1_not_configured', 'Set LB_S1_ORG_ID and LB_S1_USER_ID on the server');
  }
  return Response.json({ orgId: process.env.LB_S1_ORG_ID, userId: process.env.LB_S1_USER_ID },
    { headers: { 'cache-control': 'no-store' } });
}

const workspace = route({ role: 'viewer' }, async ({ ctx, url }) => {
  const projectId = url.searchParams.get('project');
  const target = projectId ? await getProjectTarget(ctx.db, ctx.orgId, projectId) : undefined;
  const environments = await ctx.db.query<{ id: string; name: string; role: string }>(
    'SELECT DISTINCT ON (role) id,name,role FROM execution_environments WHERE name IN ($1,$2) ORDER BY role,version DESC',
    ['original-glibc', targetEnvironment(target?.id ?? 'typescript')],
  );
  if (!projectId) return { body: { environments } };
  const heads = await getHeads(ctx.db, ctx.orgId, projectId);
  const cases = await ctx.db.query<{ id: string; name: string; capture_id: string | null; capture_deterministic: boolean | null }>(
    `SELECT c.id,c.name,o.id AS capture_id,o.deterministic AS capture_deterministic FROM test_cases c
     LEFT JOIN LATERAL (
       SELECT id,deterministic FROM reference_outputs WHERE org_id=c.org_id AND test_case_id=c.id
       AND provenance='captured_original' AND source_revision_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1
     ) o ON true WHERE c.project_id=$1 AND c.org_id=$2 ORDER BY c.created_at,c.id`, [projectId, ctx.orgId, heads.current_source_revision_id],
  );
  const [generation] = await ctx.db.query<{ id: string; status: string; progress: unknown }>(
    "SELECT id,status,progress FROM jobs WHERE org_id=$1 AND project_id=$2 AND kind='generate' AND subject_id=$3 AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1",
    [ctx.orgId, projectId, heads.approved_scope_revision_id]);
  const summaries = await ctx.db.query<{ id: string }>(
    'SELECT id FROM verification_runs WHERE project_id=$1 AND org_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',
    [projectId, ctx.orgId],
  );
  const runs = await Promise.all(summaries.map(r => getVerificationRun(ctx, r.id)));
  const run = runs.find(r => r.applies_to_current) ?? runs[0] ?? null;
  const [exp] = run?.applies_to_current ? await ctx.db.query<{ id: string }>(
    'SELECT id FROM export_packages WHERE project_id=$1 AND org_id=$2 AND verification_run_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',
    [projectId, ctx.orgId, run.id],
  ) : [];
  const [source] = heads.current_source_revision_id ? await ctx.db.query<{ execution_consent_at: string | null; path: string }>(
    `SELECT r.execution_consent_at, a.path FROM source_revisions r JOIN source_artifacts a ON a.source_revision_id=r.id AND a.org_id=r.org_id
     WHERE r.id=$1 AND r.org_id=$2 AND a.role='primary_executable'`, [heads.current_source_revision_id, ctx.orgId],
  ) : [];
  const [caseSet] = heads.current_case_set_revision_id ? await ctx.db.query<{ entries: { test_case_id: string; reference_output_id: string | null }[] }>(
    'SELECT entries FROM case_set_revisions WHERE id=$1 AND org_id=$2 AND project_id=$3',
    [heads.current_case_set_revision_id, ctx.orgId, projectId],
  ) : [];
  return { body: { environments, cases, generation: generation ?? null, caseSet: caseSet?.entries ?? [], run, export: exp ? await getExport(ctx, exp.id) : null, source: source ?? null } };
});

export const s1Workspace = (req: Request) => enabled(req) ? workspace(req) : Promise.resolve(problem(404, 'not_found', 'Local S1 mode is disabled'));

// The browser sends bytes to its own origin. The server puts them to S3 using the upload session's signed request.
type Segment = { params: Promise<Record<string, string | string[]>> };
const upload = route<{ uid: string }>({ role: 'editor' }, async ({ ctx, req, params }) => {
  const [session] = await ctx.db.query<{ declared_size: string; declared_sha256: string }>(
    "SELECT declared_size,declared_sha256 FROM upload_sessions WHERE id=$1 AND org_id=$2 AND status='pending' AND expires_at>now()",
    [params.uid, ctx.orgId],
  );
  if (!session) return problem(404, 'not_found', 'Active upload session not found');
  const size = Number(session.declared_size);
  if (size > 16 * 1024 * 1024) return problem(413, 'artifact_too_large', 'This S1 upload is limited to 16 MiB');
  const reader = req.body?.getReader();
  if (!reader) return problem(400, 'missing_upload', 'No upload bytes received');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > size) { await reader.cancel(); return problem(422, 'size_mismatch', 'Upload size does not match its declaration'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (total !== size) return problem(422, 'size_mismatch', 'Upload size does not match its declaration');
  const signed = await ctx.store.presignPut(ctx.orgId, params.uid, session.declared_sha256, size);
  const result = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(Buffer.concat(chunks, total)), redirect: 'error' });
  if (!result.ok) return problem(502, 'storage_upload_failed', 'Object storage rejected the upload');
  return { status: 204 };
});

export const s1Upload = (req: Request, segment: Segment) => enabled(req) ? upload(req, segment) : Promise.resolve(problem(404, 'not_found', 'Local S1 mode is disabled'));

// Follow only the server-generated storage URL. The authenticated browser never needs S3 credentials or CORS.
const download = route<{ eid: string }>({ role: 'viewer' }, async ({ ctx, params }) => {
  const exp = await getExport(ctx, params.eid);
  if (exp.status !== 'ready') return problem(409, 'export_not_ready', 'Export is not ready');
  const [item] = await ctx.db.query<{ package_blob_sha256: string }>(
    'SELECT package_blob_sha256 FROM export_packages WHERE id=$1 AND org_id=$2', [params.eid, ctx.orgId],
  );
  const blob = await ctx.store.get(ctx.orgId, item.package_blob_sha256);
  return new Response(new Uint8Array(blob), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="legacy-bridge-export.zip"', 'cache-control': 'no-store' } });
});

export const s1Download = (req: Request, segment: Segment) => enabled(req) ? download(req, segment) : Promise.resolve(problem(404, 'not_found', 'Local S1 mode is disabled'));
