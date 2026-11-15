import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const entry = '/opt/rea/node_modules/rea-agents/scripts/rea.mjs';
const cap = 300_000;
const all = ['wordfreq', 'intcalc', 'rand'].flatMap(name => [name, name + '.stripped']);
const selected = process.argv.slice(2);
if (selected.some(name => !all.includes(name))) throw new Error('Unknown fixture');
const fixtures = selected.length ? selected : all;
const operations = [
  ['procedures', (path) => ['search', path, '.+', '--kind', 'procedures', '--mode', 'regex']],
  ['strings', (path) => ['search', path, '.+', '--kind', 'strings', '--mode', 'regex']],
  ['xrefs', (path, address) => ['xrefs', path, address]],
  ['decompile', (path, address) => ['decompile', path, address]],
];
if (fixtures.length > 1) {
  // Each fixture gets its own REA home. The outer cgroup caps the entire batch.
  let next = 0;
  async function batch() {
    while (next < fixtures.length) {
      const fixture = fixtures[next++];
      await new Promise(resolve => {
        execFile(process.execPath, [process.argv[1], fixture], {
          env: { ...process.env, HOME: process.env.HOME + '/' + fixture },
          timeout: cap * 2 + 20_000,
        }, (error, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (error) { process.exitCode = 1; console.error(fixture + ' failed: ' + error.code); }
          resolve();
        });
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, fixtures.length) }, batch));
  process.exit(process.exitCode ?? 0);
}
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync('/results', { recursive: true });

function dataSize(result) {
  if (typeof result === 'string') return result.trim().length;
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const rows = Object.values(result).find(Array.isArray);
    const text = result.pseudo_code ?? result.pseudocode ?? result.code;
    if (rows) return rows.length;
    if (typeof text === 'string') return text.trim().length;
  }
  return 0;
}

function benchmark(fixture, pass) {
  const file = '/fixtures/' + fixture;
  const scope = '/results/' + fixture + '/pass-' + pass;
  mkdirSync(scope, { recursive: true });
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const address = readFileSync(file.replace(/\.stripped$/, '') + '.address', 'utf8').trim();
  const started = Date.now();
  const results = Object.fromEntries(operations.map(([name, args]) => {
    const at = Date.now();
    const remaining = cap - (at - started);
    if (remaining <= 0) return [name, { state: 'timed_out', ms: 0 }];
    const command = [entry, ...args(file, address), '--provider', 'ghidra', '--json'];
    const sub = spawnSync(process.execPath, command, { timeout: remaining, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    const ms = Date.now() - at;
    writeFileSync(scope + '/' + name + '.json', sub.stdout ?? '');
    writeFileSync(scope + '/' + name + '.stderr', sub.stderr ?? '');
    let json;
    try { json = JSON.parse(sub.stdout); } catch { /* record invalid JSON as a failed experiment */ }
    const id = json?.evidence_id;
    const count = dataSize(json?.normalized_result);
    const observedSha = json?.subject?.digest?.sha256;
    const profile = json?.analysis_profile?.provider?.id === 'ghidra'
      ? json.analysis_profile.provider : json?.analysis_profile?.parameters?.upstream_analysis_profile?.provider;
    const state = sub.error?.code === 'ETIMEDOUT' ? 'timed_out'
      : sub.status !== 0 || !/^ev_[a-f0-9]+$/.test(id ?? '') || observedSha !== sha256 || !count || profile?.id !== 'ghidra'
        ? 'failed' : 'works';
    return [name, { state, ms, id: id ?? null, count, ghidra: profile?.version ?? null,
      exit: sub.status, error: json?.error?.code ?? sub.error?.code ?? null }];
  }));
  return { sha256, address, elapsed_ms: Date.now() - started, results };
}

const suites = [];
for (const fixture of fixtures) {
  // Per pass, each command starts a separate fresh REA process. Both passes use the same artifact bytes and path.
  const first = benchmark(fixture, 1);
  const second = benchmark(fixture, 2);
  const equalIds = Object.fromEntries(operations.map(([name]) => [
    name, first.results[name].id && second.results[name].id ? first.results[name].id === second.results[name].id : null,
  ]));
  const suite = { fixture, first, second, equal_ids: equalIds };
  suites.push(suite);
  writeFileSync('/results/' + fixture + '/summary.json', JSON.stringify(suite, null, 2) + '\n');
  console.log(JSON.stringify({
    fixture, elapsed_ms: [first.elapsed_ms, second.elapsed_ms],
    operations: Object.fromEntries(operations.map(([name]) => [name, [first.results[name].state, second.results[name].state]])),
    equal_ids: equalIds,
  }));
}
try { console.log('cgroup_memory_peak_bytes=' + readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()); }
catch { /* Some runtimes expose memory accounting only outside the container. */ }
if (suites.some(s => [s.first, s.second].some(p => Object.values(p.results).some(r => r.state !== 'works')))) process.exitCode = 1;
