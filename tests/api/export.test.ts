/**
 * S6 export content, no Docker: a generated module (fake provider, real local tsc build) with an untranslated item, a user-supplied
 * reference, a nondeterministic captured reference and a normalized match go through verification and `buildExport`.
 * Substitutes: PGlite (unless TEST_DATABASE_URL is set), FsBlobStore, FAKE generator, unsandboxed host tsc build,
 * LocalReplacementRunner (no container), and seeded rows for the captured reference and the analysis finding (no original binary was run).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPARE_ENGINE_VERSION } from '@lb/compare';
import { testDb } from '../helpers/testdb';
import type { Db } from '../../server/db/db';
import { uuidv7 } from '../../server/db/ids';
import { FsBlobStore } from '../../server/storage/fs';
import { putBlob } from '../../server/storage/blobs';
import type { Ctx } from '../../server/domain/ctx';
import { createScopeRevision, decideScope, putScopeDraft } from '../../server/domain/projects';
import { requestGeneration } from '../../server/domain/generation';
import { createModuleRevision } from '../../server/domain/modules';
import { createCaseSet, createPolicy, createTestCase, supplyReference } from '../../server/domain/cases';
import { createVerificationRun } from '../../server/domain/verification';
import { createExport, getExport } from '../../server/domain/exports';
import { CONTROLS, ensureEnvironment } from '../../server/domain/environments';
import { drain } from '../../workers/main';
import { buildExport, NODE_IMAGE, type BuiltExport } from '../../workers/export/build';
import { localBuild } from '../../workers/build/local';
import { LocalReplacementRunner } from '../../workers/execution/runners';
import type { CodeGenerator, GenerationResult } from '../../workers/generation/provider';
import type { WorkerEnv } from '../../workers/runtime';

const root = join(__dirname, '../..');
const org = uuidv7(), user = uuidv7(), pid = uuidv7(), srcId = uuidv7();
const GOOD = `/* LB-BEHAVIOR:count */
export async function run(input: { argv: string[]; stdin: Uint8Array }, deps: { cwd: string }): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  void deps;
  return { stdout: String(Buffer.from(input.stdin).toString('utf8').split(/\\s+/).filter(Boolean).length) + '\\n' };
}
/* LB-UNTRANSLATED:overflow */
`;
const generated: GenerationResult = {
  files: [{ path: 'src/index.ts', content: GOOD }],
  untranslated: [{ id: 'overflow', behaviorId: 'count', file: 'src/index.ts', line: 7, reason: 'Original wraps at 2^31; not reproduced', evidence: [] }],
  notes: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, transcript: { fake: true }, modelVersion: 'fake-1.0',
};
const fake: CodeGenerator = { describe: () => ({ provider: 'fake', model: 'fake-1' }), async generate() { return structuredClone(generated); } };

let db: Db, c: Ctx, env: WorkerEnv, findingId: string, runId: string, exportId: string, scopeId: string, moduleId: string, binSha: string;
let first: BuiltExport;
const text = (b: BuiltExport, path: string) => b.files.find((f) => f.path === path)!.content.toString();
const has = (b: BuiltExport, path: string) => b.files.some((f) => f.path === path);
const exp = (includeOriginal: boolean) => buildExport({ db, store: c.store, orgId: org, exportId, createdAt: '2026-01-01T00:00:00.000Z', repoRoot: root, includeOriginal });

async function observation(stdout: string, stderr = '') {
  const o = await putBlob(db, c.store, org, Buffer.from(stdout)), e = await putBlob(db, c.store, org, Buffer.from(stderr));
  return { exit: { code: 0, signal: null }, stdout: { sha256: o.sha256, size: o.size, blob: o.sha256 }, stderr: { sha256: e.sha256, size: e.size, blob: e.sha256 }, files: [], truncated: { stdout: false, stderr: false, files: false }, complete: true };
}

beforeAll(async () => {
  db = await testDb();
  c = { db, store: new FsBlobStore(mkdtempSync(join(tmpdir(), 'export-blobs-'))), orgId: org, userId: user };
  await db.query("INSERT INTO organizations(id,name,external_model_allowed) VALUES ($1,'o',true)", [org]);
  await db.query("INSERT INTO users(id,email) VALUES ($1,'u@x')", [user]);
  await db.query("INSERT INTO projects(id,org_id,name) VALUES ($1,$2,'Count Words')", [pid, org]);
  binSha = (await putBlob(db, c.store, org, Buffer.from('ELF-STUB'))).sha256;
  await db.query("INSERT INTO source_revisions(id,org_id,project_id,number,manifest_sha256) VALUES ($1,$2,$3,1,'m')", [srcId, org, pid]);
  await db.query("INSERT INTO source_artifacts(source_revision_id,org_id,path,role,blob_sha256,size_bytes) VALUES ($1,$2,'bin/wc','primary_executable',$3,8)", [srcId, org, binSha]);
  await db.query('UPDATE projects SET current_source_revision_id=$2 WHERE id=$1', [pid, srcId]);
  const analysis = uuidv7();
  await db.query("INSERT INTO analysis_runs(id,org_id,project_id,source_revision_id,kind,provider,provider_version,params_digest,outcome) VALUES ($1,$2,$3,$4,'index','rea-ghidra',$5,'d','complete')", [analysis, org, pid, srcId, JSON.stringify({ ghidra: '12.1', 'rea-agents': '6.9.0' })]);
  findingId = uuidv7();
  await db.query(`INSERT INTO findings(id,org_id,source_revision_id,analysis_run_id,kind,stable_key,name,address,authority,attributes,location,artifact_path,artifact_sha256,provider_evidence_id)
    VALUES ($1,$2,$3,$4,'function','fn:1','count_words','0x401000','tool_inferred','{}','{}','bin/wc',$5,$6)`, [findingId, org, srcId, analysis, binSha, 'ev_' + 'a'.repeat(64)]);

  const replacement = await ensureEnvironment(db, { name: 'replacement-node22', version: 1, role: 'replacement', image_digest: NODE_IMAGE, arch: process.arch, controls: CONTROLS });
  const original = await ensureEnvironment(db, { name: 'original-glibc', version: 1, role: 'original', image_digest: 'debian:bookworm-slim', arch: 'x86-64', controls: CONTROLS });
  env = { db, store: c.store, workRoot: mkdtempSync(join(tmpdir(), 'export-work-')), workerId: 'w-export', original: { run: async () => { throw new Error('no original in this test'); } }, replacement: new LocalReplacementRunner(), build: (f) => localBuild(f, { repoRoot: root }), generator: fake };

  await putScopeDraft(db, org, pid, { workflow: { name: 'Word counter', invocation: { argv_template: [], stdin: 'text' } }, interface: { language: 'typescript', export: 'run' }, behaviors: [{ id: 'count', statement: 'Counts words on stdin', basis: 'inferred', evidence: [findingId] }] }, null, user);
  const scope = await createScopeRevision(db, org, pid, 1, user);
  await decideScope(db, org, pid, scope.id, 'approved', scope.document_sha256, user);
  scopeId = scope.id;
  await requestGeneration(c, pid, { scope_revision_id: scopeId });
  await drain(env, ['generate']);
  await drain(env, ['build']);
  moduleId = (await db.query<{ id: string }>('SELECT id FROM module_revisions WHERE project_id=$1 ORDER BY number DESC LIMIT 1', [pid]))[0].id;

  // Case A: user-supplied reference, byte-equal. Case C: user-supplied reference that matches only after normalization.
  const a = (await createTestCase(c, pid, 'user supplied', { stdin: { text: 'one two three\n' } })).id;
  const b = (await createTestCase(c, pid, 'nondeterministic', { stdin: { text: 'a b' } })).id;
  const n = (await createTestCase(c, pid, 'normalized', { stdin: { text: 'x' } })).id;
  const refA = (await supplyReference(c, a, { exit: { code: 0, signal: null }, stdout: { text: '3\n' } }, 'Checked by hand against the legacy tool')).id;
  const refC = (await supplyReference(c, n, { exit: { code: 0, signal: null }, stdout: { text: '1 \n' } }, 'Checked by hand against the legacy tool')).id;
  const refB = uuidv7();
  await db.query(`INSERT INTO reference_outputs(id,org_id,test_case_id,provenance,source_revision_id,execution_env_id,capture_job_id,observation,repeat_count,deterministic,variance)
    VALUES ($1,$2,$3,'captured_original',$4,$5,$6,$7,3,false,$8)`, [refB, org, b, srcId, original, uuidv7(), JSON.stringify(await observation('2\n')), JSON.stringify({ channels: ['stderr'] })]);
  await createCaseSet(c, pid, [{ test_case_id: a, reference_output_id: refA }, { test_case_id: b, reference_output_id: refB }, { test_case_id: n, reference_output_id: refC }]);
  await createPolicy(c, pid, { engine: COMPARE_ENGINE_VERSION, stdout: { mode: 'normalized', normalizers: [{ id: 'trailing-whitespace', version: 1 }] }, stderr: { mode: 'ignore', reason: 'stderr varies between captures (scope note)' } });
  const run = await createVerificationRun(c, pid, { environment_id: replacement });
  runId = run.run_id;
  await drain(env, ['verify']);
  exportId = (await createExport(c, pid, { verification_run_id: runId })).export_id;
  first = await exp(false);
}, 180_000);

describe('S6 export content', () => {
  it('verification matched all three cases, one only after normalization', async () => {
    const r = (await db.query<{ summary: Record<string, number>; completeness: string }>('SELECT summary, completeness FROM verification_runs WHERE id=$1', [runId]))[0];
    expect(r).toMatchObject({ completeness: 'complete', summary: { match: 3, difference: 0 } });
  });

  it('lists the untranslated behavior and the normalized match in unresolved.json and UNRESOLVED.md', () => {
    const u = JSON.parse(text(first, 'unresolved.json'));
    expect(u.untranslated).toEqual([{ id: 'overflow', behavior_id: 'count', file: 'src/index.ts', line: 7, reason: 'Original wraps at 2^31; not reproduced' }]);
    expect(u.normalized_matches).toHaveLength(1);
    expect(u.normalized_matches[0].trace[0]).toMatchObject({ channel: 'stdout', normalizer: 'trailing-whitespace@1' });
    expect(u.nondeterministic_references).toBe(1);
    expect(u.ignored_channels).toEqual(['stderr']);
    const md = text(first, 'UNRESOLVED.md');
    expect(md).toContain('overflow');
    expect(md).toContain('Original wraps at 2^31');
    expect(md).toContain('only after normalization or tolerance (1)');
    expect(md).toContain('normalized');
    const manifest = JSON.parse(text(first, 'MANIFEST.json'));
    expect(manifest.unresolved).toMatchObject({ untranslated: 1, normalized_matches: 1, nondeterministic_references: 1, ignored_channels: ['stderr'] });
    expect(manifest.summary).toMatchObject({ match: 3 });
  });

  it('evidence/findings.json has the cited finding with provenance', () => {
    const ev = JSON.parse(text(first, 'evidence/findings.json'));
    expect(ev.findings).toEqual([expect.objectContaining({ id: findingId, kind: 'function', name: 'count_words', address: '0x401000', authority: 'tool_inferred', provider: 'rea-ghidra', provider_version: { ghidra: '12.1', 'rea-agents': '6.9.0' }, artifact_sha256: binSha, provider_evidence_id: 'ev_' + 'a'.repeat(64) })]);
  });

  it('records the nondeterministic reference variance in provenance', () => {
    const provs = first.files.filter((f) => f.path.endsWith('/provenance.json')).map((f) => JSON.parse(f.content.toString()));
    expect(provs.find((p) => p.deterministic === false)).toMatchObject({ provenance: 'captured_original', repeat_count: 3, variance: { channels: ['stderr'] } });
    expect(provs.filter((p) => p.provenance === 'user_supplied')).toHaveLength(2);
  });

  it('ships module package.json, a runnable example, and the bound engine version', () => {
    expect(JSON.parse(text(first, 'module/package.json'))).toMatchObject({ name: 'lb-module', type: 'module' });
    expect(has(first, 'module/dist/index.js')).toBe(true);
    expect(has(first, 'module/bin/cli.mjs')).toBe(true);
    const ex = text(first, 'module/examples/basic.mjs');
    expect(ex).toContain("from '../dist/index.js'");
    expect(ex).toContain('now:');
    expect(ex).toContain('random:');
    const manifest = JSON.parse(text(first, 'MANIFEST.json'));
    expect(manifest.binding.compare_engine).toBe(COMPARE_ENGINE_VERSION);
    expect(JSON.parse(text(first, 'results/verification-summary.json')).compare_engine).toBe(COMPARE_ENGINE_VERSION);
    expect(text(first, 'README.md')).toContain(`compare engine ${COMPARE_ENGINE_VERSION}`);
  });

  it('README and Dockerfile.original differ correctly with and without the original binary', async () => {
    expect(has(first, 'original/bin/wc')).toBe(false);
    expect(text(first, 'README.md')).toContain('The original binary is not included');
    expect(text(first, 'environment/Dockerfile.original')).toContain('NOT included');
    expect(text(first, 'environment/Dockerfile.original')).not.toMatch(/^COPY /m);
    const withOriginal = await exp(true);
    expect(withOriginal.files.find((f) => f.path === 'original/bin/wc')!.content.toString()).toBe('ELF-STUB');
    expect(text(withOriginal, 'README.md')).toContain('original/bin');
    expect(text(withOriginal, 'README.md')).toContain('chmod +x');
    expect(text(withOriginal, 'environment/Dockerfile.original')).toContain('COPY --chmod=0755 original/bin/ /opt/legacy/bin/');
    expect(text(withOriginal, 'environment/Dockerfile.original')).not.toContain('NOT included');
  });

  it('the same binding rebuilds to identical SHA256SUMS after the project moves on; applies_to_current is read-time only', async () => {
    expect((await getExport(c, exportId)).applies_to_current).toBe(true);
    expect(text(first, 'MANIFEST.json')).not.toContain('applies_to_current');
    const edit = await createModuleRevision(c, pid, { scope_revision_id: scopeId, origin: 'user_edit', parent_id: moduleId, changes: [{ path: 'src/index.ts', content: GOOD + '// edited\n' }] });
    await drain(env, ['build']);
    expect(edit.is_current).toBe(true);
    const again = await exp(false);
    expect(again.sumsSha).toBe(first.sumsSha);
    expect(text(again, 'SHA256SUMS')).toBe(text(first, 'SHA256SUMS'));
    expect(await getExport(c, exportId)).toMatchObject({ applies_to_current: false, stale_reasons: ['module_revision_changed'] });
  }, 120_000);
});
