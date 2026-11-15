import type { Ctx } from './ctx';
import { DomainError } from './errors';
import { digest } from './canonical';
import { uuidv7 } from '../db/ids';
import { enqueue, finish, type Job } from '../jobs/queue';
import { putBlob } from '../storage/blobs';

export const FINDING_KINDS = ['function', 'string', 'xref', 'import', 'pseudocode'] as const;
type FindingKind = typeof FINDING_KINDS[number];
export type NativeFinding = {
  kind: FindingKind;
  stableKey: string;
  name?: string;
  address?: string;
  authority: 'observed_static' | 'tool_inferred';
  attributes: Record<string, unknown>;
  location: Record<string, unknown>;
  providerEvidenceId: string;
  content?: Buffer;
};
export type NativeAnalysisResult = {
  outcome: 'complete' | 'partial' | 'unsupported' | 'failed';
  artifactSha256: string;
  versions: { rea: string; ghidra: string; image: string };
  coverage: Record<string, unknown>;
  limitations: string[];
  unknowns?: string[];
  evidence: { kind: string; raw: Buffer }[];
  findings: NativeFinding[];
};

const provider = 'rea-ghidra';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const evidenceId = /^ev_[a-f0-9]{64}$/;
const analysisAddress = /^(?:ram:)?0x([0-9a-f]{1,16})$/i;
const unavailable = () => new DomainError('not_found', 404);
const toJson = (x: unknown) => JSON.stringify(x);

export function normalizeAddress(input: string) {
  const m = analysisAddress.exec(input.trim());
  if (!m) throw new DomainError('invalid_address', 422, 'Enter a hexadecimal virtual address.');
  return '0x' + m[1].toLowerCase().replace(/^0+(?=.)/, '');
}

async function sourceProject(c: Ctx, sourceId: string) {
  if (!uuid.test(sourceId)) throw unavailable();
  const [r] = await c.db.query<{ project_id: string }>(
    `SELECT s.project_id FROM source_revisions s JOIN projects p
       ON p.org_id=s.org_id AND p.id=s.project_id AND p.deleted_at IS NULL
     WHERE s.id=$1 AND s.org_id=$2`, [sourceId, c.orgId],
  );
  if (!r) throw unavailable();
  return r.project_id;
}

type AnalysisRequest = { kind: 'index'; params?: undefined } | { kind: 'deep_function'; params: { address: string } };

export async function queueNativeAnalysis(c: Ctx, sourceId: string, request: AnalysisRequest) {
  const projectId = await sourceProject(c, sourceId);
  const address = request.kind === 'deep_function' ? normalizeAddress(request.params.address) : undefined;
  if (address) {
    const found = await c.db.query(
      "SELECT 1 FROM findings WHERE org_id=$1 AND source_revision_id=$2 AND kind='function' AND address=$3",
      [c.orgId, sourceId, address],
    );
    if (!found.length) throw new DomainError('unknown_function', 422, 'Index the executable and select a known function first.');
  }
  const kind = request.kind === 'index' ? 'native_index' : 'native_deep_function';
  const job = await enqueue(c.db, {
    orgId: c.orgId, projectId, kind, subjectType: 'source_revision', subjectId: sourceId,
    payload: address ? { address } : {}, dedupeKey: `${kind}:${sourceId}:${address ?? ''}`,
  });
  return { run_id: job.id, job_id: job.id };
}

function evidenceBundle(result: NativeAnalysisResult) {
  if (result.evidence.length > 64 || result.findings.length > 8192 ||
      result.evidence.reduce((sum, e) => sum + e.raw.length, 0) > 24 * 1024 ** 2) {
    throw new DomainError('evidence_too_large', 422);
  }
  const records: Record<string, string> = Object.create(null);
  for (const item of result.evidence) {
    const raw = item.raw.toString('utf8');
    const data = JSON.parse(raw);
    if (!evidenceId.test(data?.evidence_id ?? '') || data.subject?.digest?.sha256 !== result.artifactSha256) {
      throw new DomainError('invalid_evidence_provenance', 422);
    }
    if (records[data.evidence_id] !== undefined && records[data.evidence_id] !== raw) {
      throw new DomainError('ambiguous_evidence_id', 422);
    }
    records[data.evidence_id] = raw;
  }
  if (result.findings.some(f => !Object.hasOwn(records, f.providerEvidenceId))) {
    throw new DomainError('unresolved_provider_evidence', 422);
  }
  return records;
}

/** A final run and its immutable findings are visible together; a stale or cancelled worker cannot publish them. */
export async function persistNativeAnalysis(c: Ctx, job: Job, result: NativeAnalysisResult, workerId: string) {
  const sourceId = job.subject_id;
  if (job.org_id !== c.orgId || !sourceId || !job.project_id || !['native_index', 'native_deep_function'].includes(job.kind)) {
    throw new DomainError('invalid_analysis_job', 422);
  }
  const [artifact] = await c.db.query<{ path: string }>(
    `SELECT a.path FROM source_artifacts a JOIN source_revisions s ON s.org_id=a.org_id AND s.id=a.source_revision_id
      WHERE a.org_id=$1 AND a.source_revision_id=$2 AND a.role='primary_executable' AND a.blob_sha256=$3 AND s.project_id=$4`,
    [c.orgId, sourceId, result.artifactSha256, job.project_id],
  );
  if (!artifact) throw new DomainError('invalid_artifact_provenance', 422);
  const records = evidenceBundle(result);
  const bundle = Object.keys(records).length
    ? await putBlob(c.db, c.store, c.orgId, Buffer.from(toJson({ schema_version: 1, records })), 'application/json') : null;
  const contents = new Map<string, string>();
  const findings = new Map(result.findings.map(f => [f.stableKey, f]));
  for (const f of findings.values()) {
    if (f.content) {
      if (f.content.length > 2 * 1024 ** 2) throw new DomainError('evidence_too_large', 422);
      contents.set(f.stableKey, (await putBlob(c.db, c.store, c.orgId, f.content, 'text/plain')).sha256);
    }
  }
  return c.db.tx(async t => {
    const owned = await t.query(
      `SELECT id FROM jobs WHERE id=$1 AND org_id=$2 AND lease_owner=$3 AND status='running'
        AND lease_expires_at>now() AND cancel_requested_at IS NULL FOR UPDATE`,
      [job.id, c.orgId, workerId],
    );
    if (owned.length === 0) return false;
    const kind = job.kind === 'native_index' ? 'index' : 'deep_function';
    const inserted = await t.query(
      `INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,job_id,kind,provider,provider_version,params,
        params_digest,outcome,coverage,limitations,unknowns,raw_evidence_blob_sha256,finished_at)
      VALUES ($1,$2,$3,$4,$1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [job.id, c.orgId, job.project_id, sourceId, kind, provider, toJson(result.versions), toJson(job.payload), digest(job.payload),
        result.outcome, toJson(result.coverage), toJson(result.limitations), toJson(result.unknowns ?? []), bundle?.sha256 ?? null],
    );
    if (!inserted.length) return finish(t, job.id, workerId, { status: 'succeeded' });
    const rows = [...findings.values()].map(f => ({
      id: uuidv7(), kind: f.kind, stable_key: f.stableKey, name: f.name ?? null,
      address: f.address ? normalizeAddress(f.address) : null, authority: f.authority,
      attributes: f.attributes, location: f.location, provider_evidence_id: f.providerEvidenceId,
      content_blob_sha256: contents.get(f.stableKey) ?? null,
    }));
    if (rows.length) await t.query(
      `INSERT INTO findings(id,org_id,source_revision_id,analysis_run_id,kind,stable_key,name,address,authority,
        attributes,location,artifact_path,artifact_sha256,provider_evidence_id,content_blob_sha256)
       SELECT x.id,$1,$2,$3,x.kind,x.stable_key,x.name,x.address,x.authority,x.attributes,x.location,$4,$5,x.provider_evidence_id,x.content_blob_sha256
       FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,kind text,stable_key text,name text,address text,authority text,
          attributes jsonb,location jsonb,provider_evidence_id text,content_blob_sha256 text)`,
      [c.orgId, sourceId, job.id, artifact.path, result.artifactSha256, toJson(rows)],
    );
    return finish(t, job.id, workerId, { status: 'succeeded' });
  });
}

export async function listNativeRuns(c: Ctx, sourceId: string) {
  const projectId = await sourceProject(c, sourceId);
  return { runs: await c.db.query(
    `SELECT j.id,j.id AS job_id,CASE WHEN j.kind='native_index' THEN 'index' ELSE 'deep_function' END AS kind,
       j.status,j.error,j.payload AS params,j.created_at,r.outcome,r.coverage,r.limitations,r.unknowns,r.provider_version
     FROM jobs j LEFT JOIN analysis_runs r ON r.org_id=j.org_id AND r.id=j.id
     WHERE j.org_id=$1 AND j.project_id=$2 AND j.subject_id=$3 AND j.kind IN ('native_index','native_deep_function')
     ORDER BY j.created_at DESC,j.id DESC LIMIT 100`, [c.orgId, projectId, sourceId],
  ) };
}

type Run = { id: string; coverage: Record<string, unknown> | null; limitations: string[] | null };
async function pickRun(c: Ctx, sourceId: string, runId?: string) {
  await sourceProject(c, sourceId);
  if (runId && !uuid.test(runId)) throw unavailable();
  const [run] = await c.db.query<Run>(
    `SELECT id,coverage,limitations FROM analysis_runs
     WHERE org_id=$1 AND source_revision_id=$2 AND provider=$3 AND
       (($4::uuid IS NOT NULL AND id=$4) OR ($4::uuid IS NULL AND kind='index' AND outcome IN ('complete','partial')))
     ORDER BY created_at DESC,id DESC LIMIT 1`, [c.orgId, sourceId, provider, runId ?? null],
  );
  if (!run && runId) throw unavailable();
  return run;
}

type FindingRow = {
  id: string; kind: FindingKind; stable_key: string; name: string | null; address: string | null; authority: string;
  attributes: Record<string, unknown>; location: unknown; artifact_path: string; artifact_sha256: string;
  provider_evidence_id: string; analysis_run_id: string; content_blob_sha256: string | null;
  provider: string; provider_version: unknown;
};
const findingQuery = `SELECT f.*,r.provider,r.provider_version FROM findings f
  JOIN analysis_runs r ON r.org_id=f.org_id AND r.id=f.analysis_run_id`;
function publicFinding(f: FindingRow) {
  return {
    id: f.id, kind: f.kind, stable_key: f.stable_key, name: f.name, address: f.address,
    attributes: f.attributes, authority: f.authority,
    provenance: {
      run_id: f.analysis_run_id, provider: f.provider, provider_version: f.provider_version,
      artifact_path: f.artifact_path, artifact_sha256: f.artifact_sha256, location: f.location,
      provider_evidence_id: f.provider_evidence_id,
      raw_url: `/api/v1/analysis-runs/${f.analysis_run_id}/evidence/${f.provider_evidence_id}`,
    },
  };
}

export async function listFindings(c: Ctx, sourceId: string, options: {
  runId?: string; kind?: FindingKind; q: string; limit: number; cursor?: string;
}) {
  let runId = options.runId;
  let after = '';
  if (options.cursor) {
    try {
      const [id, key, kind, query] = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (!uuid.test(id) || typeof key !== 'string' || key.length > 1024 || key.includes('\0') ||
          kind !== (options.kind ?? '') || query !== options.q || (runId && id !== runId)) throw new Error();
      runId = id; after = key;
    } catch { throw new DomainError('invalid_cursor', 400); }
  }
  const run = await pickRun(c, sourceId, runId);
  if (!run) return { items: [], next_cursor: null, coverage: null, run_id: null };
  const rows = await c.db.query<FindingRow>(
    findingQuery + ` WHERE f.org_id=$1 AND f.source_revision_id=$2 AND f.analysis_run_id=$3
     AND f.stable_key>$4 AND ($5::text IS NULL OR f.kind=$5)
     AND ($6='' OR strpos(lower(coalesce(f.name,'') || ' ' || coalesce(f.address,'')),lower($6))>0)
     ORDER BY f.stable_key LIMIT $7`,
    [c.orgId, sourceId, run.id, after, options.kind ?? null, options.q, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const next = rows.length > options.limit
    ? Buffer.from(toJson([run.id, page.at(-1)!.stable_key, options.kind ?? '', options.q])).toString('base64url') : null;
  return { items: page.map(publicFinding), next_cursor: next, coverage: { ...run.coverage, limitations: run.limitations ?? [] }, run_id: run.id };
}

export async function getFinding(c: Ctx, id: string) {
  if (!uuid.test(id)) throw unavailable();
  const [f] = await c.db.query<FindingRow>(findingQuery + `
    JOIN projects p ON p.id=r.project_id AND p.org_id=r.org_id AND p.deleted_at IS NULL WHERE f.org_id=$1 AND f.id=$2`, [c.orgId, id]);
  if (!f) throw unavailable();
  return { ...publicFinding(f), content: f.content_blob_sha256 ? (await c.store.get(c.orgId, f.content_blob_sha256)).toString('utf8') : null };
}

export async function getRawEvidence(c: Ctx, runId: string, id: string) {
  if (!uuid.test(runId) || !evidenceId.test(id)) throw unavailable();
  const [run] = await c.db.query<{ raw_evidence_blob_sha256: string | null }>(
    `SELECT r.raw_evidence_blob_sha256 FROM analysis_runs r JOIN projects p
      ON p.id=r.project_id AND p.org_id=r.org_id AND p.deleted_at IS NULL
      WHERE r.org_id=$1 AND r.id=$2 AND r.provider=$3`, [c.orgId, runId, provider],
  );
  if (!run?.raw_evidence_blob_sha256) throw unavailable();
  const bundle = JSON.parse((await c.store.get(c.orgId, run.raw_evidence_blob_sha256)).toString('utf8'));
  const raw = bundle.records?.[id];
  if (typeof raw !== 'string') throw unavailable();
  return raw;
}

/** C runtime and loader boilerplate, including Ghidra's synthesized names for it. Never a feature of the program. */
const RUNTIME_FUNCTION = /^(_start|entry|_init|_fini|_dl_\w+|deregister_tm_clones|register_tm_clones|__do_global_dtors_aux|frame_dummy|__libc_csu_\w+|_DT_\w+|_(INIT|FINI)_\d+|__\w+)$/;
const MAX_CANDIDATES = 12;

/**
 * Functions that look like the program's own. Compilers lay a binary out as: PLT stubs, `_start`, a short block of C runtime
 * functions that ends with `frame_dummy` (a thunk to `register_tm_clones`), then the program's functions, then `_fini`.
 * Ghidra marks that last runtime function as a thunk to an internal address, with or without symbols, so the program starts after it.
 * Import thunks, externals and runtime names are dropped. This is a layout heuristic for GCC-style binaries and can be wrong for others.
 */
export async function listCandidates(c: Ctx, sourceId: string) {
  const run = await pickRun(c, sourceId);
  if (!run) return { items: [], run_id: null };
  const rows = await c.db.query<{ id: string; kind: FindingKind; name: string | null; address: string | null; location: Record<string, unknown>; attributes: Record<string, unknown> }>(
    `SELECT id,kind,name,address,location,attributes FROM findings WHERE org_id=$1 AND source_revision_id=$2
     AND analysis_run_id=$3 AND kind IN ('function','xref') ORDER BY stable_key`, [c.orgId, sourceId, run.id],
  );
  const refsByTarget = new Map<string, string[]>();
  for (const row of rows) {
    const target = row.location.target;
    if (row.kind !== 'xref' || typeof target !== 'string') continue;
    const refs = refsByTarget.get(target) ?? [];
    if (refs.length < 4) refs.push(row.id);
    refsByTarget.set(target, refs);
  }
  const num = (a: string | null | undefined) => (a ? parseInt(a.replace(/^0x/i, ''), 16) : NaN);
  const functions = rows.filter(r => r.kind === 'function' && Number.isFinite(num(r.address)) && !r.name?.startsWith('<EXTERNAL>'))
    .sort((a, b) => num(a.address) - num(b.address));
  const entry = functions.find(r => r.name === 'entry' || r.name === '_start');
  const target = (r: (typeof functions)[number]) => (r.attributes.procedure as { thunk_target?: string | null } | undefined)?.thunk_target;
  // First internal thunk after the entry point: the end of the C runtime block.
  const crtEnd = functions.find(r => r.attributes.thunk === true && (!entry || num(r.address) > num(entry.address))
    && typeof target(r) === 'string' && !String(target(r)).startsWith('EXTERNAL') && num(target(r)) < num(r.address) && num(target(r)) > num(entry?.address ?? '0'));
  const from = num((crtEnd ?? entry)?.address ?? '0');
  const program = functions.filter(r => r.attributes.thunk !== true && num(r.address) > from && !(r.name && RUNTIME_FUNCTION.test(r.name)));
  const items = program.map(row => {
    const linked = refsByTarget.get(row.address!) ?? [];
    const main = row.name === 'main';
    return {
      title: row.name ?? row.address!,
      findings: [row.id, ...linked],
      signals: [...(main ? ['entry_point_name'] : []), ...(linked.length ? ['incoming_references'] : [])],
      score: Number(main) * 1000 + linked.length,
      at: num(row.address),
    };
  }).sort((a, b) => b.score - a.score || a.at - b.at);
  return { items: items.slice(0, MAX_CANDIDATES).map(({ score, at, ...item }) => item), run_id: run.id };
}
