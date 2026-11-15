const OPERATIONS = {
  procedures: 'search_procedures',
  strings: 'search_strings',
  xrefs: 'xrefs',
  decompile: 'procedure_pseudo_code',
} as const;
const MAX_FINDINGS = 8192;

export type ReaEvidenceKind = keyof typeof OPERATIONS;
export type ReaVersions = { rea: string; ghidra: string; image: string };
export type ReaFinding = {
  kind: 'function' | 'string' | 'xref' | 'import' | 'pseudocode';
  stableKey: string;
  name?: string;
  address?: string;
  authority: 'observed_static' | 'tool_inferred';
  attributes: Record<string, unknown>;
  location: Record<string, unknown>;
  providerEvidenceId: string;
  content?: Buffer;
};

export type ReaAnalysisResult = {
  outcome: 'complete' | 'partial' | 'unsupported' | 'failed';
  artifactSha256: string;
  versions: ReaVersions;
  limitations: string[];
  coverage: Record<string, unknown>;
  evidence: { kind: ReaEvidenceKind; raw: Buffer }[];
  findings: ReaFinding[];
};

type OperationStatus = 'complete' | 'timeout' | 'failed' | 'invalid' | 'unavailable' | 'bounded';
export type ReaOperation =
  | { kind: ReaEvidenceKind; address?: string; status: 'complete'; evidence: ReaEvidence }
  | { kind: ReaEvidenceKind; address?: string; status: Exclude<OperationStatus, 'complete'> };

interface ReaEvidence {
  raw: Buffer;
  id: string;
  ghidraVersion: string;
  limitations: string[];
  result: unknown[] | string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function storageText(value: string): string {
  return value.toWellFormed().replaceAll('\0', '\uFFFD');
}

function storageValue(value: unknown): unknown {
  if (typeof value === 'string') return storageText(value);
  if (Array.isArray(value)) return value.map(storageValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [storageText(key), storageValue(entry)]));
}

export function canonicalReaAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(?:ram:)?0x[0-9a-f]{1,16}$/i.test(value)) return;
  return `0x${BigInt(value.replace(/^ram:/i, '')).toString(16)}`;
}

function evidenceAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return canonicalReaAddress(value) ?? (/^[\w.%~-]{1,240}:0x[0-9a-f]{1,16}$/i.test(value) ? value : undefined);
}

/** Verify the pinned provider's evidence belongs to the inputs of this operation. */
export function normalizeReaEvidence(raw: Buffer, kind: ReaEvidenceKind, sha: string, address?: string): ReaEvidence {
  const data = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)));
  const provider = object(object(data.analysis_profile).provider);
  const parameters = object(data.parameters);
  const result = data.normalized_result;
  const evidenceId = data.evidence_id;
  const addressMatches = kind === 'xrefs' || kind === 'decompile'
    ? address !== undefined && canonicalReaAddress(kind === 'xrefs' ? parameters.address : parameters.procedure) === address
    : parameters.pattern === '.+' && parameters.mode === 'regex';
  if (data.operation !== OPERATIONS[kind] || provider.id !== 'ghidra' || typeof provider.version !== 'string'
    || object(object(data.subject).digest).sha256 !== sha || typeof evidenceId !== 'string'
    || !/^ev_[a-f0-9]{64}$/.test(evidenceId) || !addressMatches
    || (kind === 'decompile' ? result !== null && typeof result !== 'string' : !Array.isArray(result))) {
    throw new Error('invalid_provider_evidence');
  }
  return {
    raw, id: evidenceId, ghidraVersion: provider.version,
    limitations: Array.isArray(data.limitations) ? data.limitations.filter((item): item is string => typeof item === 'string') : [],
    result: result as ReaEvidence['result'],
  };
}

function inventoryFindings(kind: 'procedures' | 'strings', evidence: ReaEvidence): ReaFinding[] {
  const findings: ReaFinding[] = [];
  for (const row of evidence.result as unknown[]) {
    const fields = object(row);
    const rowAddress = fields.address;
    const name = fields.value;
    if (typeof name !== 'string' || typeof rowAddress !== 'string') continue;
    const address = canonicalReaAddress(rowAddress);
    if (kind === 'strings') {
      const location = evidenceAddress(rowAddress);
      if (location) findings.push({
        kind: 'string', stableKey: `string:${location}`, address, name, authority: 'observed_static',
        attributes: object(fields.string), location: { address: location }, providerEvidenceId: evidence.id,
      });
      continue;
    }
    const procedure = object(fields.procedure);
    const symbol = object(fields.symbol);
    if (procedure.external === true && /^EXTERNAL:0x[0-9a-f]{1,16}$/i.test(rowAddress)) {
      findings.push({
        kind: 'import', stableKey: `import:${rowAddress}`, name, authority: 'observed_static',
        attributes: { symbol, procedure }, location: { address: rowAddress, addressSpace: 'EXTERNAL' }, providerEvidenceId: evidence.id,
      });
    } else if (address && procedure.external === false) {
      findings.push({
        kind: 'function', stableKey: `function:${address}`, address, name, authority: 'tool_inferred',
        attributes: { symbol, procedure, thunk: procedure.thunk === true },
        location: { address }, providerEvidenceId: evidence.id,
      });
    }
  }
  return findings;
}

export function selectIndexAddress(operation: ReaOperation): string | undefined {
  if (operation.status !== 'complete' || operation.kind !== 'procedures') return;
  const functions = inventoryFindings(operation.kind, operation.evidence).filter((finding) =>
    finding.kind === 'function' && finding.attributes.thunk === false);
  return (functions.find((finding) => finding.name === 'main')
    ?? functions.find((finding) => finding.name === 'entry' || finding.name === '_start')
    ?? functions[0])?.address;
}

export function buildReaAnalysisResult(options: {
  artifactSha256: string;
  versions: ReaVersions;
  operations?: ReaOperation[];
  limitations?: string[];
  outcome?: ReaAnalysisResult['outcome'];
  scope: 'inventory' | 'function';
}): ReaAnalysisResult {
  const { artifactSha256, versions, scope, operations = [] } = options;
  const evidence: ReaAnalysisResult['evidence'] = [];
  const findings = new Map<string, ReaFinding>();
  const limitations = new Set(options.limitations);
  const operationCoverage: Record<string, unknown>[] = [];
  let verified = 0;
  let coverageGaps = 0;

  for (const operation of operations) {
    const { kind, address, status } = operation;
    if (status !== 'complete') {
      coverageGaps++;
      limitations.add(`${kind}:${status}`);
      operationCoverage.push({ kind, address, status });
      continue;
    }
    const observed = operation.evidence;
    verified++;
    for (const limitation of observed.limitations) limitations.add(storageText(limitation));
    evidence.push({ kind, raw: observed.raw });
    const normalized: ReaFinding[] = [];
    if (kind === 'procedures' || kind === 'strings') {
      normalized.push(...inventoryFindings(kind, observed));
    } else if (kind === 'xrefs' && address) {
      for (const item of observed.result as unknown[]) {
        const from = evidenceAddress(item);
        if (from) normalized.push({
          kind: 'xref', stableKey: `xref:${from}:${address}`, address: canonicalReaAddress(from), authority: 'observed_static',
          attributes: { from, target: address, type: 'unknown' },
          location: { address: from, target: address }, providerEvidenceId: observed.id,
        });
      }
    } else if (kind === 'decompile' && address && typeof observed.result === 'string'
      && observed.result.trim() && Buffer.byteLength(observed.result) <= 2 * 1024 ** 2) {
      normalized.push({
        kind: 'pseudocode', stableKey: `pseudocode:${address}`, address, authority: 'tool_inferred',
        attributes: { language: 'c-pseudocode' }, location: { address },
        providerEvidenceId: observed.id, content: Buffer.from(observed.result),
      });
    }
    const received = Array.isArray(observed.result) ? observed.result.length : 1;
    let capped = false;
    let indexed = 0;
    for (const finding of normalized) {
      const prior = findings.get(finding.stableKey);
      if (!prior && findings.size >= MAX_FINDINGS) {
        capped = true;
        continue;
      }
      indexed++;
      if (!prior || object(finding.attributes.symbol).primary === true) {
        findings.set(finding.stableKey, {
          ...finding, name: finding.name === undefined ? undefined : storageText(finding.name),
          attributes: object(storageValue(finding.attributes)),
        });
      }
    }
    if (capped) limitations.add(`Analysis retained the first ${MAX_FINDINGS} distinct findings. Raw provider evidence includes omitted rows from successful operations.`);
    if (normalized.length < received) limitations.add(`${kind}:unavailable_rows`);
    const hasGap = capped || normalized.length < received;
    if (hasGap) {
      coverageGaps++;
    }
    operationCoverage.push({ kind, address, status: hasGap ? 'partial' : 'complete', rows: received, indexedRows: indexed });
  }

  if (scope === 'inventory') limitations.add('Inventory covers Ghidra-discovered entries and defined strings only. Total recoverable coverage is unknown.');
  if (operations.some(({ kind }) => kind === 'xrefs')) limitations.add('Cross-references are incoming references to selected addresses. Reference kinds and a complete call graph are unavailable.');
  const rows = [...findings.values()];
  const timedOut = operations.some(({ status }) => status === 'timeout');
  const outcome = options.outcome ?? (timedOut || (verified > 0 && coverageGaps > 0) ? 'partial' : verified > 0 ? 'complete' : 'failed');
  return {
    outcome, artifactSha256, versions, limitations: [...limitations],
    coverage: {
      scope, completeness: scope === 'inventory' ? 'provider_inventory_only' : 'selected_function_only',
      operations: operationCoverage,
      functions: rows.filter((row) => row.kind === 'function' && !row.attributes.thunk).length,
      thunks: rows.filter((row) => row.kind === 'function' && row.attributes.thunk).length,
      imports: rows.filter((row) => row.kind === 'import').length,
      strings: rows.filter((row) => row.kind === 'string').length,
      xrefs: rows.filter((row) => row.kind === 'xref').length,
      pseudocode: rows.filter((row) => row.kind === 'pseudocode').length,
    },
    evidence, findings: rows,
  };
}
