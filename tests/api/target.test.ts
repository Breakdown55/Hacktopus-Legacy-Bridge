/** Every project target carries through approval, generation and source validation. */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../helpers/testdb';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { setApp } from '../../server/app';
import { api } from '../../server/api/handlers';
import { createScopeRevision, decideScope, putScopeDraft } from '../../server/domain/projects';
import type { Db } from '../../server/db/db';
import { moduleTarget, targetEnvironment, targetOf, TARGET_IDS, type TargetLanguage } from '@lb/contracts';
import { drain } from '../../workers/main';
import { writeTree, type WorkerEnv } from '../../workers/runtime';
import { DockerReplacementRunner } from '../../workers/execution/runners';
import { NODE_IMAGE, targetImage } from '../../workers/build/toolchains';
import { localBuild } from '../../workers/build/local';
import { createCaseSet, createPolicy, createTestCase, supplyReference } from '../../server/domain/cases';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { createVerificationRun } from '../../server/domain/verification';
import { createExport } from '../../server/domain/exports';
import { buildExport } from '../../workers/export/build';
import { CodexGenerator } from '../../workers/generation/codex';
import type { GenerationRequest } from '../../workers/generation/provider';

process.env.LB_DEV_AUTH = '1';
const org = uuidv7(), user = uuidv7();
let db: Db;
let store: FsBlobStore;
const enabled = process.env.LB_TEST_TARGET_TOOLCHAINS === '1';
const root = join(__dirname, '../..');
async function call(h: (r: Request, s?: any) => Promise<Response>, method: string, o: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-org-id': org, 'x-user-id': user };
  if (method === 'POST') headers['idempotency-key'] = uuidv7();
  const res = await h(new Request('http://t/x', { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function approvedScope(pid: string, language: TargetLanguage) {
  const src = uuidv7();
  await db.query("INSERT INTO blobs(org_id,sha256,size_bytes,storage_key) VALUES ($1,$2,1,'k') ON CONFLICT DO NOTHING", [org, 'd'.repeat(64)]);
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [src, org, pid]);
  await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/tool','primary_executable',$3,1)", [src, org, 'd'.repeat(64)]);
  await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [pid, src]);
  await putScopeDraft(db, org, pid, {
    workflow: { name: 'Echo', invocation: { argv_template: [], stdin: 'bytes' } },
    interface: { language, export: targetOf(language).symbol },
    behaviors: [{ id: 'b', statement: 'Copy the bytes of stdin to stdout unchanged, leave stderr empty, and return exit code 0.', basis: 'observed' }],
  }, null, user);
  const scope = await createScopeRevision(db, org, pid, 1, user);
  await decideScope(db, org, pid, scope.id, 'approved', scope.document_sha256, user);
  return scope.id;
}
const sources: Record<TargetLanguage, string> = {
  typescript: '/* LB-BEHAVIOR:b */\nexport async function run(input: {stdin: Uint8Array}) { return { stdout: Buffer.from(input.stdin).toString("utf8") }; }',
  python: '# LB-BEHAVIOR:b\ndef run(args, stdin, stdout, stderr):\n    stdout.write(stdin.read())\n    return 0\n',
  go: 'package replacement\nimport "io"\n// LB-BEHAVIOR:b\nfunc Run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int { io.Copy(stdout, stdin); return 0 }\n',
  java: 'package legacybridge;\n// LB-BEHAVIOR:b\npublic final class Replacement { public static int run(String[] a, java.io.InputStream i, java.io.OutputStream o, java.io.OutputStream e) throws Exception { i.transferTo(o); return 0; } }\n',
  csharp: 'namespace LegacyBridge;\n// LB-BEHAVIOR:b\npublic static class Replacement { public static int Run(string[] a, System.IO.Stream i, System.IO.Stream o, System.IO.Stream e) { i.CopyTo(o); return 0; } }\n',
};

beforeAll(async () => {
  db = await testDb();
  store = new FsBlobStore(mkdtempSync(join(tmpdir(), 'target-blobs-')));
  setApp({ db, store });
  await db.query("INSERT INTO organizations(id,name,external_model_allowed) VALUES ($1,'o',true)", [org]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
  await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin')", [org, user]);
});

describe('project packaging target', () => {
  it('defaults to TypeScript, stores the chosen target, and rejects unknown ones', async () => {
    const ts = await call(api.projectsCreate, 'POST', { body: { name: 'a' } });
    expect(ts.status).toBe(201);
    expect((await call(api.projectGet, 'GET', { params: { pid: ts.json.id } })).json.target_language).toBe('typescript');
    const py = await call(api.projectsCreate, 'POST', { body: { name: 'b', target_language: 'python' } });
    expect((await call(api.projectGet, 'GET', { params: { pid: py.json.id } })).json.target_language).toBe('python');
    expect((await call(api.projectsCreate, 'POST', { body: { name: 'c', target_language: 'cobol' } })).status).toBe(422);
  });

  it.each(TARGET_IDS)('routes %s generation and uploads through the selected source contract', async language => {
    const target = targetOf(language);
    const project = await call(api.projectsCreate, 'POST', { body: { name: language, target_language: language } });
    expect(project.status).toBe(201);
    const pid = project.json.id;
    expect((await call(api.projectGet, 'GET', { params: { pid } })).json.target_language).toBe(language);
    const scope = await approvedScope(pid, language);
    const uploaded = await call(api.moduleCreate, 'POST', { params: { pid }, body: { origin: 'customer_upload', scope_revision_id: scope,
      files: [{ path: language === 'typescript' ? 'src/replacement.py' : 'src/index.ts', content: 'wrong target' }] } });
    expect(uploaded).toMatchObject({ status: 422, json: { code: 'invalid_path' } });
    await exerciseGeneration(pid, scope, language, false);
  });
});

async function exerciseGeneration(pid: string, scope: string, language: TargetLanguage, live: boolean) {
  const target = targetOf(language);
  const requests: GenerationRequest[] = [];
  const env: WorkerEnv = { db, store, workRoot: mkdtempSync(join(tmpdir(), 'target-work-')), workerId: 'target-worker',
    original: { run: async () => { throw new Error('using a supplied reference'); } },
    replacement: new DockerReplacementRunner(NODE_IMAGE), build: files => localBuild(files, { repoRoot: root }),
    generator: live && process.env.LB_TEST_TARGET_CODEX === '1' ? new CodexGenerator({ binary: process.env.LB_CODEX_BIN }) : {
      describe: () => ({ provider: 'fake', model: 'target-fixture' }),
      async generate(req) {
        requests.push(req);
        const files = [{ path: target.entry, content: sources[language] }];
        return { files, untranslated: [], notes: '', usage: { inputTokens: 1, outputTokens: 1 }, transcript: { request: req } };
      },
    },
  };
  const generated = await call(api.moduleCreate, 'POST', { params: { pid }, body: { origin: 'generated', scope_revision_id: scope } });
  expect(generated.status).toBe(202);
  await drain(env, ['generate']);
  const job = (await call(api.jobGet, 'GET', { params: { jid: generated.json.job_id } })).json;
  expect(job, JSON.stringify(job.error)).toMatchObject({ status: 'succeeded' });
  if (requests.length) expect(requests[0].target).toMatchObject({ language, entry: target.entry, runtime: target.runtime });
  const [module] = await db.query<{ id: string; target: string; file_manifest: { path: string }[] }>(
    'SELECT id,target,file_manifest FROM module_revisions WHERE project_id=$1', [pid]);
  expect(module).toMatchObject({ target: moduleTarget(language), file_manifest: expect.arrayContaining([expect.objectContaining({ path: target.entry })]) });
  return env;
}

describe.skipIf(!enabled)('target toolchains in Docker', () => {
  it.each(TARGET_IDS)('builds, verifies, exports and replays a %s module', async language => {
    const project = await call(api.projectsCreate, 'POST', { body: { name: 'Docker ' + language, target_language: language } });
    const pid = project.json.id;
    const env = await exerciseGeneration(pid, await approvedScope(pid, language), language, true);
    await drain(env, ['build']);
    const [built] = await db.query<{ status: string; diagnostics: unknown }>(
      'SELECT b.status,b.diagnostics FROM build_results b JOIN module_revisions m ON m.id=b.module_revision_id WHERE m.project_id=$1', [pid]);
    expect(built?.status, JSON.stringify(built?.diagnostics)).toBe('succeeded');
    const ctx = { db, store, orgId: org, userId: user };
    const replacement = await ensureEnvironment(db, { name: targetEnvironment(language), version: 1, role: 'replacement',
      image_digest: targetImage(language), arch: 'x86-64', controls: CONTROLS });
    const payload = 'hello\n';
    const test = await createTestCase(ctx, pid, 'Copy bytes', { stdin: { text: payload } });
    const reference = await supplyReference(ctx, test.id, { exit: { code: 0, signal: null }, stdout: { text: payload } }, 'Synthetic fixture expected output');
    await createCaseSet(ctx, pid, [{ test_case_id: test.id, reference_output_id: reference.id }]);
    await createPolicy(ctx, pid, null);
    const run = await createVerificationRun(ctx, pid, { environment_id: replacement });
    await drain(env, ['verify']);
    const [verification] = await db.query<{ summary: unknown; diagnostics: unknown; differences: unknown }>(
      'SELECT v.summary,r.diagnostics,r.differences FROM verification_runs v JOIN verification_results r ON r.verification_run_id=v.id WHERE v.id=$1', [run.run_id]);
    expect(verification?.summary, JSON.stringify(verification)).toMatchObject({ match: 1, difference: 0, couldnt_run: 0 });
    const exported = await createExport(ctx, pid, { verification_run_id: run.run_id });
    const output = await buildExport({ db, store, orgId: org, exportId: exported.export_id, createdAt: '2026-01-01T00:00:00.000Z', repoRoot: root, includeOriginal: false });
    expect(output.manifest).toMatchObject({ binding: { module_revision: { target: moduleTarget(language) } } });
    expect(output.files.some(f => f.path === 'module/' + targetOf(language).entry)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'target-export-'));
    writeTree(dir, output.files);
    execFileSync(process.execPath, [join(dir, 'harness/verify-integrity.mjs')], { timeout: 30_000 });
    const out = join(dir, 'replay-report.json');
    execFileSync(process.execPath, [join(dir, 'harness/run-cases.mjs'), '--docker', '--out', out], { timeout: 180_000, cwd: dir });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ ok: true, summary: { match: 1 } });
  }, 300_000);
});
