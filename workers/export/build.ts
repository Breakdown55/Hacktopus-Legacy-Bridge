import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { moduleLanguage, targetOf, type CaseInput, type Observation } from '@lb/contracts';
import { COMPARE_ENGINE_VERSION } from '@lb/compare';
import type { Db } from '../../server/db/db';
import type { BlobStore } from '../../server/storage/blobstore';
import { canonical } from '../../server/domain/canonical';
import { citedFindingIds } from '../../server/domain/scope';
import { bindingDigest } from '../../server/domain/verification';
import { unpackTar } from '../../server/tar';
import { TSCONFIG } from '../build/templates';
import { NODE_IMAGE, targetCommand } from '../build/toolchains';
import { RUN_CASES, VERIFY_INTEGRITY } from './templates';
import { basicExample, dockerfileOriginal, normalizeUntranslated, readme, unresolvedMarkdown } from './content';
import { zip } from './zip';

export { NODE_IMAGE };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const j = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n');

/** Bundles compare + harness into one dependency-free ESM file for the export. */
export async function bundleHarness(repoRoot: string): Promise<Buffer> {
  const r = await build({ entryPoints: [join(repoRoot, 'workers/export/entry.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent', legalComments: 'none' });
  return Buffer.from(r.outputFiles[0].text);
}

export interface BuiltExport { files: { path: string; content: Buffer }[]; manifest: Record<string, unknown>; manifestSha: string; sumsSha: string; zip: Buffer; rootName: string }

export async function buildExport(a: { db: Db; store: BlobStore; orgId: string; exportId: string; createdAt: string; repoRoot: string; includeOriginal: boolean; harness?: Buffer }): Promise<BuiltExport> {
  const { db, store, orgId } = a;
  const one = async <T>(sql: string, p: unknown[]) => { const r = await db.query<T>(sql, p); if (!r[0]) throw new Error(`missing row for ${sql.slice(0, 40)}`); return r[0]; };
  const ex = await one<{ project_id: string; verification_run_id: string }>('SELECT project_id, verification_run_id FROM export_packages WHERE id=$1 AND org_id=$2', [a.exportId, orgId]);
  const run = await one<Record<string, any>>('SELECT * FROM verification_runs WHERE id=$1 AND org_id=$2', [ex.verification_run_id, orgId]);
  const project = await one<{ name: string }>('SELECT name FROM projects WHERE id=$1', [ex.project_id]);
  const scope = await one<{ document: any; document_sha256: string; id: string }>('SELECT id, document, document_sha256 FROM scope_revisions WHERE id=$1', [run.scope_revision_id]);
  const approval = await one<{ decided_by: string; created_at: string }>("SELECT decided_by, created_at FROM approvals WHERE scope_revision_id=$1 AND decision='approved'", [run.scope_revision_id]);
  const mod = await one<{ file_manifest: { path: string; sha256: string }[]; tree_sha256: string; origin: string; generator: unknown; untranslated: unknown; target: string }>('SELECT file_manifest, tree_sha256, origin, generator, untranslated, target FROM module_revisions WHERE id=$1', [run.module_revision_id]);
  const language = moduleLanguage(mod.target);
  if (!language) throw new Error('unknown module target');
  const target = targetOf(language);
  const build = await one<{ output_blob_sha256: string; build_image_digest: string; toolchain: unknown }>('SELECT output_blob_sha256, build_image_digest, toolchain FROM build_results WHERE id=$1', [run.build_result_id]);
  const csr = await one<{ entries: { test_case_id: string; reference_output_id: string | null }[]; digest: string }>('SELECT entries, digest FROM case_set_revisions WHERE id=$1', [run.case_set_revision_id]);
  const policy = await one<{ rules: Record<string, any>; digest: string }>('SELECT rules, digest FROM comparison_policies WHERE id=$1', [run.comparison_policy_id]);
  const replEnv = await one<{ id: string; image_digest: string; controls: unknown; name: string; version: number }>('SELECT id, image_digest, controls, name, version FROM execution_environments WHERE id=$1', [run.replacement_env_id]);
  const results = await db.query<{ test_case_id: string; outcome: string; raw_equal: boolean | null; normalized: boolean; normalization_trace: unknown; differences: unknown; diagnostics: unknown }>('SELECT test_case_id, outcome, raw_equal, normalized, normalization_trace, differences, diagnostics FROM verification_results WHERE verification_run_id=$1', [run.id]);
  const resultOf = new Map(results.map((r) => [r.test_case_id, r]));
  // The engine the run was bound to is only recoverable by recomputing the stored binding digest (the binding column does not store it).
  const engineBound = bindingDigest(run.binding) === run.binding_digest;
  const engine = engineBound ? COMPARE_ENGINE_VERSION : 'unknown';
  const inspect = (await db.query<{ facts: any }>("SELECT facts FROM analysis_runs WHERE source_revision_id=$1 AND kind='inspect' AND outcome IS NOT NULL ORDER BY created_at DESC LIMIT 1", [run.source_revision_id]))[0];
  const src = await one<{ manifest_sha256: string }>('SELECT manifest_sha256 FROM source_revisions WHERE id=$1', [run.source_revision_id]);
  const primary = (await db.query<{ path: string; blob_sha256: string; role: string }>("SELECT path, blob_sha256, role FROM source_artifacts WHERE source_revision_id=$1 AND org_id=$2 ORDER BY path", [run.source_revision_id, orgId]));
  const primaryArt = primary.find((p) => p.role === 'primary_executable')!;

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  const rootName = `legacy-bridge-${slug}-${a.exportId.replace(/-/g, '').slice(-8)}`;
  const files: { path: string; content: Buffer }[] = [];
  const add = (path: string, content: Buffer | string) => files.push({ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });

  // module/: editable source + prebuilt output + supervisor templates
  for (const f of mod.file_manifest) add(`module/${f.path}`, await store.get(orgId, f.sha256));
  for (const f of unpackTar(await store.get(orgId, build.output_blob_sha256))) add(`module/${f.path}`, f.content);
  if (language === 'typescript') add('module/tsconfig.json', TSCONFIG);
  add('module/INTERFACE.md', `# Interface\n\n${target.label} exposes \`${target.symbol}\` from \`${target.entry}\`. The launcher in \`bin/\` maps process I/O to it.\n\n\`\`\`json\n${JSON.stringify({ ...scope.document.interface, language, export: target.symbol }, null, 2)}\n\`\`\`\n`);

  // harness/
  add('harness/lib.mjs', a.harness ?? (await bundleHarness(a.repoRoot)));
  add('harness/run-cases.mjs', RUN_CASES);
  add('harness/verify-integrity.mjs', VERIFY_INTEGRITY);

  // cases/ + results/
  const caseOutcomes: Record<string, string> = {};
  const unresolved: { id: string; outcome: string }[] = [];
  const unresolvedNamed: { id: string; name: string; outcome: string }[] = [];
  const normalizedMatches: { id: string; name: string; trace: { channel: string; normalizer: string }[] }[] = [];
  let firstArgv: string[] = [];
  let nondeterministic = 0;
  for (const e of csr.entries) {
    const tc = await one<{ input: CaseInput; name: string }>('SELECT input, name FROM test_cases WHERE id=$1 AND org_id=$2', [e.test_case_id, orgId]);
    const base = `cases/${e.test_case_id}`;
    if (e === csr.entries[0]) firstArgv = tc.input.argv;
    add(`${base}/input.json`, j({ name: tc.name, argv: tc.input.argv, env: tc.input.env, timeout_ms: tc.input.timeout_ms, files: tc.input.files.map((f) => ({ path: f.path, mode: f.mode })) }));
    if (tc.input.stdin_blob) add(`${base}/stdin.bin`, await store.get(orgId, tc.input.stdin_blob));
    for (const f of tc.input.files) add(`${base}/files/${f.path}`, await store.get(orgId, f.blob));
    if (e.reference_output_id) {
      const r = await one<any>('SELECT * FROM reference_outputs WHERE id=$1 AND org_id=$2', [e.reference_output_id, orgId]);
      const obs: Observation = r.observation;
      add(`${base}/reference/observation.json`, j(obs));
      add(`${base}/reference/stdout.bin`, obs.stdout.blob ? await store.get(orgId, obs.stdout.blob) : Buffer.alloc(0));
      add(`${base}/reference/stderr.bin`, obs.stderr.blob ? await store.get(orgId, obs.stderr.blob) : Buffer.alloc(0));
      for (const f of obs.files) if (f.blob) add(`${base}/reference/files/${f.path}`, await store.get(orgId, f.blob));
      if (r.deterministic === false) nondeterministic++;
      add(`${base}/provenance.json`, j(r.provenance === 'captured_original'
        ? { provenance: 'captured_original', source_revision: r.source_revision_id, environment: r.execution_env_id, job: r.capture_job_id, repeat_count: r.repeat_count, deterministic: r.deterministic, variance: r.variance }
        : { provenance: 'user_supplied', attestation: r.attestation, supplied_by: r.supplied_by }));
    } else add(`${base}/provenance.json`, j({ provenance: null, note: 'No independent reference for this case (needs_reference).' }));
    const res = resultOf.get(e.test_case_id);
    const outcome = res?.outcome ?? 'not_run';
    caseOutcomes[e.test_case_id] = outcome;
    if (outcome !== 'match') { unresolved.push({ id: e.test_case_id, outcome }); unresolvedNamed.push({ id: e.test_case_id, name: tc.name, outcome }); }
    else if (res && res.normalized && res.raw_equal === false) normalizedMatches.push({ id: e.test_case_id, name: tc.name, trace: (res.normalization_trace as { channel: string; normalizer: string }[]) ?? [] });
    add(`results/cases/${e.test_case_id}.json`, j({ test_case_id: e.test_case_id, name: tc.name, ...res }));
  }
  add('policy/comparison-policy.json', j(policy.rules));
  add('results/verification-summary.json', j({ compare_engine: engine, completeness: run.completeness, summary: run.summary, cases: caseOutcomes }));
  add('scope/scope-revision.json', j({ id: scope.id, sha256: scope.document_sha256, document: scope.document }));
  const cited = citedFindingIds(scope.document).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  const findings = cited.length ? await db.query<Record<string, unknown>>(
    `SELECT f.id, f.kind, f.name, f.address, f.authority, f.artifact_path, f.artifact_sha256, f.provider_evidence_id, r.provider, r.provider_version
     FROM findings f JOIN analysis_runs r ON r.id = f.analysis_run_id AND r.org_id = f.org_id WHERE f.org_id=$1 AND f.id = ANY($2::uuid[]) ORDER BY f.id`, [orgId, cited]) : [];
  add('evidence/findings.json', j({
    note: 'Findings cited by the approved scope, with provenance. The binary is not included unless the export says so. Static evidence from the executable; behavior is checked by the cases.',
    findings,
    inspection: inspect ? { ...inspect.facts, strings: undefined } : null,
  }));

  const ignored = ['stdout', 'stderr', 'exit', 'files'].filter((ch) => policy.rules[ch]?.mode === 'ignore');
  const openQuestions = (scope.document.open_questions ?? []).filter((q: any) => q.status === 'open').length;
  const untranslated = normalizeUntranslated(mod.untranslated);
  const unresolvedDoc = { untranslated, open_questions: openQuestions, nondeterministic_references: nondeterministic, ignored_channels: ignored, cases: unresolved, normalized_matches: normalizedMatches.map((m) => ({ id: m.id, trace: m.trace })) };
  add('unresolved.json', j(unresolvedDoc));
  add('UNRESOLVED.md', unresolvedMarkdown({ untranslated, cases: unresolvedNamed, normalizedMatches, openQuestions, nondeterministic, ignored }));

  // environment/
  const origEnvIds = (await db.query<{ execution_env_id: string }>('SELECT DISTINCT execution_env_id FROM reference_outputs WHERE test_case_id = ANY($1::uuid[]) AND execution_env_id IS NOT NULL', [csr.entries.map((e) => e.test_case_id)])).map((r) => r.execution_env_id);
  const origEnvs = origEnvIds.length ? await db.query<{ name: string; version: number; image_digest: string; controls: unknown }>('SELECT name, version, image_digest, controls FROM execution_environments WHERE id = ANY($1::uuid[])', [origEnvIds]) : [];
  add('environment/environment.json', j({ replacement: { name: replEnv.name, version: replEnv.version, image: replEnv.image_digest, controls: replEnv.controls }, original: origEnvs.map((o) => ({ name: o.name, version: o.version, image: o.image_digest, controls: o.controls })), build: { image: build.build_image_digest, toolchain: build.toolchain } }));
  const image = language === 'typescript' ? NODE_IMAGE : replEnv.image_digest;
  if (language !== 'typescript') add('environment/replacement-command.json', j({ argv: targetCommand(language), platform: 'linux/amd64' }));
  const goExecutable = language === 'go'
    ? 'COPY --chmod=0755 module/dist/legacy-cli /pkg/module/dist/legacy-cli\n' : '';
  add('environment/Dockerfile.replacement', `FROM ${image}\n${language === 'typescript' ? '' : `COPY --from=${NODE_IMAGE} /usr/local/bin/node /usr/local/bin/node\nENTRYPOINT []\n`}COPY . /pkg\n${goExecutable}WORKDIR /pkg\nUSER ${language === 'typescript' ? 'node' : '10001:10001'}\nCMD ["sh", "-c", "node harness/verify-integrity.mjs && node harness/run-cases.mjs --out /tmp/replay-report.json"]\n`);
  const binaryName = primaryArt.path.split('/').pop()!;
  add('environment/Dockerfile.original', dockerfileOriginal({ image: origEnvs[0]?.image_digest ?? 'debian:bookworm-slim', binaryName, includeOriginal: a.includeOriginal, hasLib: primary.some((p) => p.role === 'shared_library') }));
  add('environment/DEPENDENCIES.md', `# Dependencies\n\n- Replacement runtime: ${image} (${target.label}). The module uses standard library dependencies.\n- Controls applied during verification: TZ=UTC, LC_ALL=C.UTF-8, LB_FAKE_NOW=2000-01-01T00:00:00Z, LB_SEED=1.\n- Original run image: ${origEnvs[0]?.image_digest ?? 'n/a'}.\n`);
  if (a.includeOriginal) {
    for (const p of primary) if (['primary_executable', 'shared_library'].includes(p.role)) add(`original/${p.role === 'shared_library' ? 'lib' : 'bin'}/${p.path.split('/').pop()}`, await store.get(orgId, p.blob_sha256));
  }
  add('README.md', readme(project.name, { includeOriginal: a.includeOriginal, engine, language: target.name, docker: language !== 'typescript' }));
  if (language === 'typescript') add('module/examples/basic.mjs', basicExample(firstArgv));

  const manifest = {
    format: 'legacy-bridge-export/1',
    project: { id: ex.project_id, name: project.name },
    binding: {
      source_revision: { id: run.source_revision_id, manifest_sha256: src.manifest_sha256, primary: { path: primaryArt.path, sha256: primaryArt.blob_sha256 } },
      scope_revision: { id: scope.id, sha256: scope.document_sha256, approved_by: approval.decided_by, approved_at: new Date(approval.created_at).toISOString() },
      module_revision: { id: run.module_revision_id, tree_sha256: mod.tree_sha256, origin: mod.origin, target: mod.target, generator: mod.generator },
      build: { id: run.build_result_id, image: build.build_image_digest, toolchain: build.toolchain },
      case_set: { id: run.case_set_revision_id, digest: csr.digest }, policy: { id: run.comparison_policy_id, digest: policy.digest },
      environment: { replacement: replEnv.image_digest, original: origEnvs.map((o) => o.image_digest) },
      verification_run: { id: run.id, binding_digest: run.binding_digest, completeness: run.completeness },
      compare_engine: engine,
    },
    summary: { ...run.summary, matched_cases: Object.entries(caseOutcomes).filter(([, o]) => o === 'match').map(([id]) => id).sort(), unresolved_cases: unresolved.sort((x, y) => (x.id < y.id ? -1 : 1)) },
    unresolved: { untranslated: untranslated.length, open_questions: openQuestions, nondeterministic_references: nondeterministic, ignored_channels: ignored, normalized_matches: normalizedMatches.length },
    limitations: ['Finite test set; no universal equivalence', 'Filesystem observed only under the working directory', 'Time is controlled via LB_FAKE_NOW for the replacement; the original run used no time control in local development', ...(engineBound ? [] : ['The compare engine version this run was bound to could not be confirmed (the run predates the current engine); harness/lib.mjs is the engine at export time']), ...(run.completeness === 'partial' ? ['Partial verification run (allow_partial export)'] : []), ...(csr.entries.some((e) => !e.reference_output_id) ? ['Some cases have no independent reference'] : []), ...ignored.map((c) => `Channel not compared: ${c}`)],
  };
  add('MANIFEST.json', Buffer.from(canonical(manifest) + '\n'));

  const sums = files.filter((f) => f.path !== 'SHA256SUMS').sort((x, y) => (x.path < y.path ? -1 : 1)).map((f) => `${sha(f.content)}  ${f.path}`).join('\n') + '\n';
  add('SHA256SUMS', sums);
  add('EXPORT_ID', `${a.exportId}\n${a.createdAt}\n`);
  const archive = zip(files.map((f) => ({ path: `${rootName}/${f.path}`, content: f.content })));
  return { files, manifest, manifestSha: sha(canonical(manifest) + '\n'), sumsSha: sha(sums), zip: archive, rootName };
}
