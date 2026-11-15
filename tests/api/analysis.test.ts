import { beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { api } from '../../server/api/handlers';
import { setApp } from '../../server/app';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { DockerReaAnalysisRunner, type ReaAnalysisRunner } from '../../workers/analysis/rea/runner';
import { drain } from '../../workers/main';
import type { WorkerEnv } from '../../workers/runtime';
import { buildElf } from '../helpers/elf';
import { addAddress, defaultSpaceAddress, replayImageDigest, replayRea } from '../helpers/rea-replay';
import { testDb } from '../helpers/testdb';

const owner = { org: uuidv7(), user: uuidv7() };
const outsider = { org: uuidv7(), user: uuidv7() };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const unexpected = async (): Promise<never> => { throw new Error('Static analysis must not execute the executable or build a module'); };
let env: WorkerEnv;

beforeAll(async () => {
  process.env.LB_DEV_AUTH = '1';
  const db = await testDb();
  const store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'analysis-blobs-')));
  setApp({ db, store });
  for (const { org, user } of [owner, outsider]) {
    await db.query("INSERT INTO organizations(id,name,execution_enabled) VALUES ($1,'analysis test',false)", [org]);
    await db.query('INSERT INTO users(id,email) VALUES ($1,$2)', [user, `${user}@example.test`]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'editor')", [org, user]);
  }
  env = { db, store, workRoot: mkdtempSync(join(tmpdir(), 'analysis-work-')), workerId: 'analysis-test',
    original: { run: unexpected }, replacement: { run: unexpected }, build: unexpected };
});

type Params = Record<string, string>;
type Handler = (req: Request, route: { params: Promise<Params> }) => Promise<Response>;

async function call(handler: Handler, options: { method?: string; query?: string; params?: Params; body?: unknown;
  who?: typeof owner; headers?: Record<string, string> } = {}) {
  const { method = 'GET', query = '', params = {}, body, who = owner, headers = {} } = options;
  const response = await handler(new Request(`http://analysis.test/${query}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
      'content-type': 'application/json', 'idempotency-key': uuidv7(), 'x-org-id': who.org, 'x-user-id': who.user, ...headers,
    },
  }), { params: Promise.resolve(params) });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : null, raw };
}

async function ok(request: ReturnType<typeof call>, status = 200) {
  const response = await request;
  expect(response.status, response.raw).toBe(status);
  return response.json;
}

async function sealExecutable(bytes: Buffer, pid?: string) {
  pid ??= (await ok(call(api.projectsCreate, { method: 'POST', body: { name: 'Analyze legacy executable' } }), 201)).id as string;
  const digest = sha(bytes);
  const upload = await ok(call(api.uploadCreate, { method: 'POST', params: { pid }, body: {
    filename: 'tool', size: bytes.length, sha256: digest,
  } }), 201);
  const path = upload.url.replace(/^file:\/\//, '');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  await ok(call(api.uploadComplete, { method: 'POST', params: { uid: upload.upload_id } }));
  const source = await ok(call(api.sourceCreate, { method: 'POST', params: { pid }, body: {
    artifacts: [{ upload_id: upload.upload_id, path: 'bin/tool', role: 'primary_executable' }],
  } }), 201);
  return { pid, sid: source.id as string, digest };
}

async function analyze(sid: string, rea: ReaAnalysisRunner, address?: string) {
  const kind = address ? 'deep_function' : 'index';
  const queued = await ok(call(api.analysisRunCreate, { method: 'POST', params: { sid }, body: {
    kind, ...(address ? { params: { address } } : {}),
  } }), 202);
  expect(await drain({ ...env, rea }, [address ? 'native_deep_function' : 'native_index'])).toBe(1);
  const { runs } = await ok(call(api.analysisRunsList, { params: { sid } }));
  const run = runs.find((item: { id: string }) => item.id === queued.run_id);
  expect(run).toMatchObject({ kind, status: 'succeeded', job_id: queued.job_id });
  return run;
}

type Finding = { id: string; kind: string; name: string; address: string; stable_key: string;
  provenance: { run_id: string; artifact_sha256: string; artifact_path: string; provider_evidence_id: string } };

async function findings(sid: string, query = '', limit = 8): Promise<Finding[]> {
  const items: Finding[] = [];
  let cursor: string | null = null;
  do {
    const page = await ok(call(api.findingsList, { params: { sid }, query: `?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}` }));
    items.push(...page.items);
    const next: string | null = page.next_cursor;
    if (next && next === cursor) throw new Error('Finding cursor did not advance');
    cursor = next;
  } while (cursor);
  return items;
}

async function assertProvenance(rows: Finding[], digest: string, captures?: Map<string, Buffer>) {
  const seen = new Set<string>();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const { run_id: rid, artifact_sha256, artifact_path, provider_evidence_id: eid } = row.provenance;
    expect(artifact_sha256).toBe(digest);
    expect(artifact_path).toBe('bin/tool');
    if (seen.has(`${rid}:${eid}`)) continue;
    seen.add(`${rid}:${eid}`);
    const response = await call(api.rawEvidenceGet, { params: { rid, eid } });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ evidence_id: eid, subject: { digest: { sha256: digest } } });
    if (captures) expect(response.raw).toBe(captures.get(eid)?.toString('utf8'));
    expect((await call(api.rawEvidenceGet, { params: { rid, eid }, who: outsider })).status).toBe(404);
  }
}

it('publishes pageable finding evidence, scoped citations, and deep pseudocode through the API', async () => {
  const { pid, sid, digest } = await sealExecutable(buildElf());
  const replay = replayRea(digest);
  const rea = new DockerReaAnalysisRunner({ image: replayImageDigest, execute: replay.execute });
  const index = await analyze(sid, rea);
  expect(['complete', 'partial']).toContain(index.outcome);
  expect(index.provider_version).toEqual({ rea: '6.9.0', ghidra: '12.1', image: replayImageDigest });

  const inventory = await findings(sid);
  expect(inventory.map((item) => item.id)).toEqual((await findings(sid, '&run_id=' + index.id, 100)).map((item) => item.id));
  expect(new Set(inventory.map((item) => item.id)).size).toBe(inventory.length);
  const first = await ok(call(api.findingsList, { params: { sid }, query: '?limit=1' }));
  expect(first.next_cursor).toBeTruthy();
  const wrongFilter = await call(api.findingsList, { params: { sid }, query: `?kind=import&cursor=${first.next_cursor}` });
  expect(wrongFilter).toMatchObject({ status: 400, json: { code: 'invalid_cursor' } });
  expect(inventory.map((item) => item.kind)).toEqual(expect.arrayContaining(['function', 'import', 'string']));
  await assertProvenance(inventory, digest, replay.captures);
  const matches = await findings(sid, '&kind=string&q=StOpWoRdS.TxT');
  expect(matches).toEqual([expect.objectContaining({ name: 'stopwords.txt', kind: 'string' })]);
  const candidates = await ok(call(api.candidatesList, { params: { sid } }));
  expect(candidates.run_id).toBe(index.id);
  expect(candidates.items).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'entry', signals: expect.arrayContaining(['entry_point_name']) })]));

  const target = inventory.find((item) => item.kind === 'function' && item.address === addAddress)!;
  expect(target).toBeDefined();
  const fid = target.id;
  expect((await call(api.findingGet, { params: { fid }, who: outsider })).status).toBe(404);
  expect((await call(api.findingsList, { params: { sid }, who: outsider })).status).toBe(404);
  expect((await call(api.analysisRunCreate, { method: 'POST', params: { sid }, body: { kind: 'index' }, who: outsider })).status).toBe(404);
  expect((await call(api.analysisRunCreate, { method: 'POST', params: { sid }, body: {
    kind: 'deep_function', params: { address: '0xaaaaaaaa' },
  } })).json.code).toBe('unknown_function');

  const deep = await analyze(sid, rea, 'ram:0x00401286');
  expect(deep).toMatchObject({ outcome: 'complete', params: { address: addAddress } });
  const deepFindings = await findings(sid, '&run_id=' + deep.id);
  expect(deepFindings.filter((item) => item.kind === 'xref').map((item) => item.address)).toEqual(['0x40155e', '0x40158f', '0x402078', '0x402150']);
  const pseudocode = deepFindings.find((item) => item.kind === 'pseudocode')!;
  expect(pseudocode).toBeDefined();
  const detail = await ok(call(api.findingGet, { params: { fid: pseudocode.id } }));
  const rawPseudo = JSON.parse(replay.captures.get(pseudocode.provenance.provider_evidence_id)!.toString('utf8'));
  expect(detail.content).toBe(rawPseudo.normalized_result);
  expect(detail.content).toContain('FUN_00401286');
  await assertProvenance(deepFindings, digest, replay.captures);

  const draft = (evidenceId: string, version: number) => call(api.scopeDraftPut, { method: 'PUT', params: { pid },
    headers: { 'if-match': `"v${version}"` }, body: { document: {
      workflow: { name: 'word count', invocation: { argv_template: [] } }, interface: { language: 'typescript' },
      behaviors: [{ id: 'count', statement: 'Counts words', basis: 'inferred', evidence: [evidenceId] }],
      dependencies: [{ id: 'word-list', kind: 'filesystem', disposition: 'explicit_input', evidence: [evidenceId] }],
    } },
  });
  const invalid = await draft(uuidv7(), 0);
  expect(invalid.status).toBe(422);
  expect(invalid.json).toMatchObject({ code: 'unknown_finding', fields: [
    { path: 'behaviors[0].evidence[0]', code: 'unknown_finding' },
    { path: 'dependencies[0].evidence[0]', code: 'unknown_finding' },
  ] });
  expect(await ok(draft(fid, 0))).toMatchObject({ version: 1, document: { behaviors: [{ evidence: [fid] }] } });
  await sealExecutable(buildElf({ extraStrings: ['updated revision'] }), pid);
  const stale = await call(api.scopeRevisionCreate, { method: 'POST', params: { pid }, body: { from_draft_version: 1 } });
  expect(stale).toMatchObject({ status: 422, json: { code: 'unknown_finding' } });
  expect((await draft(fid, 1)).json.code).toBe('unknown_finding');
});

it('returns an unsupported PE outcome without invoking Docker', async () => {
  const pe = Buffer.alloc(512);
  pe.write('MZ');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  const { sid } = await sealExecutable(pe);
  const rea = new DockerReaAnalysisRunner({ image: replayImageDigest, execute: unexpected });
  const run = await analyze(sid, rea);
  expect(run).toMatchObject({ outcome: 'unsupported', limitations: expect.arrayContaining([expect.stringMatching(/PE.*outside/i)]) });
  expect(await findings(sid, '&run_id=' + run.id)).toEqual([]);
});

it('exposes a partial run and preserved findings after a provider timeout', async () => {
  const { sid, digest } = await sealExecutable(buildElf());
  const replay = replayRea(digest, 'strings');
  const rea = new DockerReaAnalysisRunner({ image: replayImageDigest, execute: replay.execute });
  const run = await analyze(sid, rea);
  expect(run).toMatchObject({ outcome: 'partial', limitations: expect.arrayContaining(['strings:timeout']) });
  const rows = await findings(sid, '&run_id=' + run.id);
  expect(rows.some((row) => row.kind === 'function')).toBe(true);
  expect(rows.some((row) => row.kind === 'string')).toBe(false);
  await assertProvenance(rows, digest, replay.captures);
});

it('discards provider output when cancellation arrives before the run is published', async () => {
  const { sid, digest } = await sealExecutable(buildElf());
  const queued = await ok(call(api.analysisRunCreate, { method: 'POST', params: { sid }, body: { kind: 'index' } }), 202);
  const jid = queued.job_id as string;
  const replay = replayRea(digest);
  const runner = new DockerReaAnalysisRunner({ image: replayImageDigest, execute: replay.execute });
  const rea: ReaAnalysisRunner = { async analyze(input) {
    const result = await runner.analyze(input);
    expect(result.findings.length).toBeGreaterThan(0);
    const cancellation = await ok(call(api.jobCancel, { method: 'POST', params: { jid } }), 202);
    expect(cancellation.status).toBe('cancel_requested');
    return result;
  } };

  expect(await drain({ ...env, rea }, ['native_index'])).toBe(1);
  expect(await ok(call(api.jobGet, { params: { jid } }))).toMatchObject({ status: 'cancelled' });
  expect(await env.db.query('SELECT id FROM analysis_runs WHERE job_id=$1', [jid])).toEqual([]);
  expect(await env.db.query('SELECT id FROM findings WHERE source_revision_id=$1', [sid])).toEqual([]);
});

const liveImage = process.env.LB_S2_TEST_IMAGE;
it.skipIf(!liveImage)('indexes and decompiles the actual stripped ELF with the pinned Docker image', async () => {
  expect(liveImage).toMatch(/^sha256:[a-f0-9]{64}$/);
  const fixturesDir = join(__dirname, '../../fixtures/bin/f1');
  const { sid, digest } = await sealExecutable(readFileSync(join(fixturesDir, 'wordfreq.stripped')));
  const oracle = readFileSync(join(fixturesDir, 'wordfreq.symbols'), 'utf8').trim().split(/\r?\n/)
    .map((line) => defaultSpaceAddress(line.split(/\s+/)[0]));
  expect(oracle.length).toBeGreaterThanOrEqual(10);

  const rea = new DockerReaAnalysisRunner({ image: liveImage!, runtime: process.env.LB_S2_TEST_RUNTIME });
  const index = await analyze(sid, rea);
  expect(index.provider_version).toEqual({ rea: '6.9.0', ghidra: '12.1', image: liveImage });
  const rows = await findings(sid);
  expect(rows.map((row) => row.kind)).toEqual(expect.arrayContaining(['function', 'string', 'import', 'xref']));
  const addresses = new Set(rows.filter((row) => row.kind === 'function').map((row) => row.address));
  const missing = oracle.filter((address) => !addresses.has(address));
  expect(1 - missing.length / oracle.length, `Undiscovered addresses: ${missing.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  await assertProvenance(rows, digest);

  const address = defaultSpaceAddress(readFileSync(join(fixturesDir, 'wordfreq.address'), 'utf8').trim());
  const deep = await analyze(sid, rea, address);
  const deepRows = await findings(sid, '&run_id=' + deep.id);
  const pseudocode = deepRows.find((row) => row.kind === 'pseudocode');
  expect(pseudocode).toBeDefined();
  const detail = await ok(call(api.findingGet, { params: { fid: pseudocode!.id } }));
  expect(detail.content).toContain('strcmp');
  await assertProvenance(deepRows, digest);
}, 11 * 60_000);
