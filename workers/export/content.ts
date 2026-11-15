/** Text builders for the export package: README, UNRESOLVED.md, Dockerfile.original, examples/basic.mjs. Pure functions, no I/O. */

export interface UntranslatedItem { id: string; behavior_id: string | null; file: string | null; line: number | null; reason: string }

/** Module rows store the model's list as `{id, behaviorId, file, line, reason, evidence}`; older rows may use `behavior_id`. */
export function normalizeUntranslated(raw: unknown): UntranslatedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return [{ id: s(o.id) ?? 'unknown', behavior_id: s(o.behaviorId) ?? s(o.behavior_id), file: s(o.file), line: typeof o.line === 'number' ? o.line : null, reason: s(o.reason) ?? '' }];
  });
}

export interface UnresolvedInput {
  untranslated: UntranslatedItem[];
  cases: { id: string; name: string; outcome: string }[];
  normalizedMatches: { id: string; name: string; trace: { channel: string; normalizer: string }[] }[];
  openQuestions: number;
  nondeterministic: number;
  ignored: string[];
}

export function unresolvedMarkdown(u: UnresolvedInput): string {
  const lines: string[] = ['# Unresolved', ''];
  lines.push(`## Behavior the module does not translate (${u.untranslated.length})`, '');
  if (!u.untranslated.length) lines.push('None recorded. This is the generator\'s or author\'s own list: it is not proof that nothing is missing.');
  for (const t of u.untranslated) lines.push(`- **${t.id}**${t.behavior_id ? ` (behavior ${t.behavior_id})` : ''}${t.file ? `, ${t.file}${t.line ? ':' + t.line : ''}` : ''}: ${t.reason || 'no reason recorded'}`);
  lines.push('', `## Cases that do not match (${u.cases.length})`, '');
  if (!u.cases.length) lines.push('None.');
  for (const c of u.cases) lines.push(`- ${c.name} (${c.id}): ${c.outcome}`);
  lines.push('', `## Cases that match only after normalization or tolerance (${u.normalizedMatches.length})`, '');
  if (!u.normalizedMatches.length) lines.push('None. Every match was byte-equal.');
  else lines.push('These are counted as matches, but the raw bytes differ. See results/cases/<id>.json for the trace.');
  for (const c of u.normalizedMatches) lines.push(`- ${c.name} (${c.id}): ${[...new Set(c.trace.map((t) => `${t.channel} via ${t.normalizer}`))].join(', ') || 'normalized'}`);
  lines.push('', '## Other open items', '', `- Open questions in the approved scope: ${u.openQuestions}`, `- Nondeterministic references: ${u.nondeterministic}`, `- Channels not compared (ignored by policy): ${u.ignored.join(', ') || 'none'}`, '');
  return lines.join('\n');
}

export function readme(name: string, o: { includeOriginal: boolean; engine: string }): string {
  return `# ${name}: Legacy Bridge export

Contents: a TypeScript module that replaces one workflow of a legacy executable, the test cases and references used to check it,
the comparison policy, the verification results, and a harness that replays everything without the Legacy Bridge product.

## Quick start (Node 22, no network needed)

    node harness/verify-integrity.mjs        # every file matches SHA256SUMS
    node harness/run-cases.mjs               # replays all cases; exits 0 only if outcomes equal results/verification-summary.json

Run \`run-cases.mjs\` from outside this folder, or pass \`--out /tmp/replay-report.json\`, so the report does not add a file to the package.
The module is prebuilt in \`module/dist\`; its editable source is \`module/src\`. \`module/examples/basic.mjs\` calls \`run()\` directly.

## What "Match" means

Match establishes that, for THIS case input, in THIS environment (see environment/), the replacement's observed channels (exit status,
stdout, stderr, files under the working directory) equaled the reference observation under THIS comparison policy.
The reference came from the original executable (provenance.json: captured_original) or from a user (user_supplied, with an attestation).

Match does NOT establish: behavior on any other input; equivalence of unobserved effects (files outside the working directory, timing,
memory, signals, network); correctness of the original or of a user-supplied reference against business requirements; equivalence in other
environments (locale, clock, glibc, Node version); absence of nondeterminism that did not show up in the captures; or anything about channels
the policy marks as ignored. A case that matched only after normalization or tolerance is listed in UNRESOLVED.md.
See MANIFEST.json "limitations" and UNRESOLVED.md for what is open.

## Compare engine

Results were produced with compare engine ${o.engine}. harness/lib.mjs is bundled from the engine version at export time.

## The original binary

${o.includeOriginal
    ? `The original executable and its libraries are included under \`original/bin\` and \`original/lib\` so references can be recaptured.
Zip files do not keep the executable bit: run \`chmod +x original/bin/*\` after unzipping. Do not run it outside a sandbox you trust.
\`environment/Dockerfile.original\` copies them to /opt/legacy/bin and /opt/legacy/lib. Build it from the package root:

    docker build -f environment/Dockerfile.original -t legacy-original .`
    : 'The original binary is not included. To recapture references, supply it yourself and mount it at /opt/legacy/bin (see environment/Dockerfile.original).'}
`;
}

export function dockerfileOriginal(a: { image: string; binaryName: string; includeOriginal: boolean; hasLib: boolean }): string {
  if (!a.includeOriginal) {
    return `# Recapture references from the original binary. It is NOT included in this package.
# Supply it at /opt/legacy/bin/${a.binaryName} (bind mount it, or add a COPY of your own copy).
FROM ${a.image}
RUN useradd -u 10001 -m lb
USER 10001
WORKDIR /work
`;
  }
  return `# Recapture references from the original binary included in original/. Build from the package root:
#   docker build -f environment/Dockerfile.original -t legacy-original .
FROM ${a.image}
RUN useradd -u 10001 -m lb
COPY --chmod=0755 original/bin/ /opt/legacy/bin/
${a.hasLib ? 'COPY original/lib/ /opt/legacy/lib/\nENV LD_LIBRARY_PATH=/opt/legacy/lib\n' : ''}USER 10001
WORKDIR /work
# Binary: /opt/legacy/bin/${a.binaryName}
`;
}

/** Calls run() directly with the supervisor's deps, using the first case's arguments. */
export function basicExample(argv: string[]): string {
  return `// Calls the module's run() directly. Needs module/dist (prebuilt in this package). Usage: node module/examples/basic.mjs
import { run } from '../dist/index.js';

const out = await run(
  { argv: ${JSON.stringify(argv)}, stdin: new Uint8Array(), env: {} },
  { now: () => new Date('2000-01-01T00:00:00Z'), random: () => 0.5, cwd: process.cwd(), env: {} },
);
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.exitCode ?? 0;
`;
}
