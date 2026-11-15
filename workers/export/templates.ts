export const RUN_CASES = `#!/usr/bin/env node
// Replays every case through the module's CLI shim and compares against the recorded references.
// Usage: node harness/run-cases.mjs [--out replay-report.json] [--docker | --original]
// Exits 0 only if every outcome equals results/verification-summary.json.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { judge, runCase, REPLACEMENT_CONTROLS, parseReplayArgs, replayInDocker, replayOriginal } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseReplayArgs(process.argv.slice(2), process.env);
if ('error' in args) {
  console.error(args.error + '\\nUsage: node harness/run-cases.mjs [--out FILE] [--docker | --original] [--docker-bin PATH]');
  process.exit(2);
}
// --docker replays inside a hardened container built from environment/Dockerfile.replacement.
// --original recaptures the cases from original/ (only if the package includes it) and reports whether the stored references still reproduce; it never changes them.
if (args.mode === 'docker') process.exit(replayInDocker(root, args));
if (args.mode === 'original') process.exit(await replayOriginal(root, args));
const outFile = args.out;
const json = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const policy = json('policy/comparison-policy.json');
const expected = json('results/verification-summary.json');
const commandPath = 'environment/replacement-command.json';
const command = existsSync(join(root, commandPath))
  ? json(commandPath).argv.map(part => part.replace('{module}', join(root, 'module')))
  : [process.execPath, join(root, 'module/bin/cli.mjs')];

if (!existsSync(join(root, commandPath)) && !existsSync(join(root, 'module/dist/index.js'))) {
  console.log('module/dist missing: building with tsc (needs network for npm ci)');
  execFileSync('npm', ['ci'], { cwd: join(root, 'module'), stdio: 'inherit' });
  execFileSync('npx', ['tsc'], { cwd: join(root, 'module'), stdio: 'inherit' });
}

const readIf = (p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
const report = { engine: expected.compare_engine, cases: {}, mismatches: [] };
for (const id of readdirSync(join(root, 'cases')).sort()) {
  const dir = join(root, 'cases', id);
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'));
  const files = input.files.map((f) => ({ path: f.path, mode: f.mode, content: readFileSync(join(dir, 'files', f.path)) }));
  let ref = null;
  if (existsSync(join(dir, 'reference/observation.json'))) {
    const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    const observation = JSON.parse(readFileSync(join(dir, 'reference/observation.json'), 'utf8'));
    const rf = {};
    for (const f of observation.files) if (f.blob) rf[f.path] = readFileSync(join(dir, 'reference/files', f.path));
    ref = { observation, stdout: readIf(join(dir, 'reference/stdout.bin')), stderr: readIf(join(dir, 'reference/stderr.bin')), files: rf, deterministic: prov.deterministic ?? undefined, varied_channels: prov.variance?.channels };
  }
  const workdir = mkdtempSync(join(tmpdir(), 'lb-replay-'));
  let run = null, err;
  try {
    run = await runCase({ command: command[0], args: [...command.slice(1), ...input.argv], controlEnv: { ...REPLACEMENT_CONTROLS, PATH: process.env.PATH ?? '', HOME: workdir, DOTNET_CLI_HOME: workdir, DOTNET_NOLOGO: '1' }, caseEnv: input.env, stdin: readIf(join(dir, 'stdin.bin')), files, workdir, timeoutMs: input.timeout_ms });
  } catch (e) { err = String(e.message); }
  const result = judge(policy, ref, run, err);
  report.cases[id] = result.outcome;
  if (result.outcome !== expected.cases[id]) report.mismatches.push({ case: id, expected: expected.cases[id], actual: result.outcome });
}
const summary = { match: 0, difference: 0, couldnt_run: 0, needs_reference: 0 };
for (const o of Object.values(report.cases)) summary[o]++;
report.summary = summary;
report.ok = report.mismatches.length === 0 && Object.keys(report.cases).length === Object.keys(expected.cases).length;
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\\n');
console.log(JSON.stringify(summary), report.ok ? 'REPLAY OK: outcomes equal the recorded summary' : 'REPLAY MISMATCH: see ' + outFile);
process.exit(report.ok ? 0 : 1);
`;

export const VERIFY_INTEGRITY = `#!/usr/bin/env node
// Recomputes every hash in SHA256SUMS. Fails on a mismatch, a missing file, or an extra file.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED = new Set(['SHA256SUMS', 'EXPORT_ID', 'replay-report.json']);
const listed = new Map();
for (const line of readFileSync(join(root, 'SHA256SUMS'), 'utf8').split('\\n').filter(Boolean)) {
  const m = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!m) { console.error('malformed line: ' + line); process.exit(1); }
  listed.set(m[2], m[1]);
}
const actual = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else actual.push(relative(root, p).split('\\\\').join('/')); } };
walk(root);
const problems = [];
for (const [p, h] of listed) {
  let got;
  try { got = createHash('sha256').update(readFileSync(join(root, p))).digest('hex'); } catch { problems.push('missing: ' + p); continue; }
  if (got !== h) problems.push('modified: ' + p);
}
for (const p of actual) if (!listed.has(p) && !IGNORED.has(p)) problems.push('extra: ' + p);
if (problems.length) { console.error('INTEGRITY FAILED\\n' + problems.join('\\n')); process.exit(1); }
console.log('integrity ok (' + listed.size + ' files)');
`;

export const README = (name: string) => `# ${name}: Legacy Bridge export

Contents: a TypeScript module that replaces one workflow of a legacy executable, the test cases and references used to check it,
the comparison policy, the verification results, and a harness that replays everything without the Legacy Bridge product.

## Quick start (Node 22, no network needed)

    node harness/verify-integrity.mjs        # every file matches SHA256SUMS
    node harness/run-cases.mjs               # replays all cases; exits 0 only if outcomes equal results/verification-summary.json

Run \`run-cases.mjs\` from outside this folder, or pass \`--out /tmp/replay-report.json\`.

## What "Match" means

Match establishes that, for THIS case input, in THIS environment (see environment/), the replacement's observed channels (exit status,
stdout, stderr, files under the working directory) equaled the reference observation under THIS comparison policy.
The reference came from the original executable (provenance.json: captured_original) or from a user (user_supplied, with an attestation).

Match does NOT establish: behavior on any other input; equivalence of unobserved effects (files outside the working directory, timing,
memory, signals, network); correctness of the original or of a user-supplied reference against business requirements; equivalence in other
environments (locale, clock, glibc, Node version); absence of nondeterminism that did not show up in the captures; or anything about channels
the policy marks as ignored. See MANIFEST.json "limitations" and UNRESOLVED.md for what is open.

The original binary is not included.
`;
