import type { ScopeDocV1 } from '@lb/contracts';

/** Generation adapter (plan §6.3). The supervisor builds the request from persisted state; no conversation state is relied upon. */
export interface CodeGenerator {
  describe(): { provider: string; model: string };
  generate(req: GenerationRequest, ctx: { signal: AbortSignal }): Promise<GenerationResult>;
}

export interface EvidenceItem { findingId: string; kind: string; name: string | null; address: string | null; artifactSha256: string; location: unknown; excerpt: string }
export interface GenerationRequest {
  templateVersion: 'ts-cli-v1';
  scope: { id: string; sha256: string; document: ScopeDocV1 };
  evidence: EvidenceItem[];
  target: { language: 'typescript'; runtime: 'node22'; entry: 'src/index.ts'; export: 'run'; allowRuntimeDeps: false; runContract: string };
  priorRevision?: { id: string; files: { path: string; content: string }[]; buildDiagnostics?: unknown[] };
  /** Free text from the user (what to change or fix). User-authored, unlike the evidence. */
  instructions?: string;
}
export interface Untranslated { id: string; behaviorId?: string; file: string; line: number; reason: string; evidence: string[] }
export interface GenerationResult {
  files: { path: string; content: string }[];
  untranslated: Untranslated[];
  notes: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Audit record, stored as a blob. Never the system of record. */
  transcript: unknown;
  modelVersion?: string;
}

export const TEMPLATE_VERSION = 'ts-cli-v1';

/**
 * The exact interface the supervisor's CLI shim (workers/build/templates.ts CLI_SHIM) calls. It is part of the request's `target`,
 * so it is digested into `input_digest`, and it is quoted in the model prompt verbatim.
 */
export const RUN_CONTRACT = `export interface RunInput { argv: string[]; stdin: Uint8Array; env: Record<string, string | undefined> }
export interface RunDeps { now(): Date; random(): number; cwd: string; env: Record<string, string | undefined> }
export interface RunOutput { stdout?: string; stderr?: string; exitCode?: number }
export async function run(input: RunInput, deps: RunDeps): Promise<RunOutput>;
// argv excludes the program name. stdout/stderr are written verbatim; exitCode defaults to 0. A thrown error becomes exit 70.
// Use deps.now() and deps.random() instead of Date/Math.random so runs are reproducible. Files are read relative to deps.cwd.`;
export const EVIDENCE_LIMITS = { perItem: 8 * 1024, total: 200 * 1024 };
