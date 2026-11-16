import type { ScopeDocV1 } from '@lb/contracts';
import { targetOf, type TargetLanguage } from '@lb/contracts';
import type { Job } from '../../server/jobs/queue';

/** Generation adapter (plan §6.3). The supervisor builds the request from persisted state; no conversation state is relied upon. */
export interface CodeGenerator {
  describe(): { provider: string; model: string };
  generate(req: GenerationRequest, ctx: { signal: AbortSignal; job?: Job }): Promise<GenerationResult>;
  suggestFunctionName?(evidence: EvidenceItem[], signal: AbortSignal): Promise<{ name: string; reason: string } | null>;
}

export interface EvidenceItem { findingId: string; kind: string; name: string | null; address: string | null; artifactSha256: string; location: unknown; excerpt: string }
export interface GenerationRequest {
  templateVersion: 'ts-cli-v1' | 'cli-module-v1';
  scope: { id: string; sha256: string; document: ScopeDocV1 };
  evidence: EvidenceItem[];
  target: { language: TargetLanguage; runtime: string; entry: string; export: string; allowRuntimeDeps: false; runContract: string };
  priorRevision?: { id: string; files: { path: string; content: string }[]; buildDiagnostics?: unknown[] };
  /** Free text from the user (what to change or fix). User-authored, unlike the evidence. */
  instructions?: string;
  activeBehaviorId?: string;
  unansweredQuestions?: string[];
  sampleInput?: { name: string; text: string };
}
export interface Untranslated { question?: string; id: string; behaviorId?: string; file: string; line: number; reason: string; evidence: string[] }
export interface GenerationResult {
  testCases?: import('../../packages/contracts/src/generation-preview').SuggestedTestCase[];
  files: { path: string; content: string }[];
  untranslated: Untranslated[];
  notes: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Audit record, stored as a blob. Never the system of record. */
  transcript: unknown;
  modelVersion?: string;
}

export const TEMPLATE_VERSION = 'ts-cli-v1';
export const PORTABLE_TEMPLATE_VERSION = 'cli-module-v1';

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

const contracts: Record<TargetLanguage, string> = {
  typescript: RUN_CONTRACT,
  python: 'In src/replacement.py define run(args: list[str], stdin: BinaryIO, stdout: BinaryIO, stderr: BinaryIO) -> int. Import BinaryIO from typing. Streams are binary. Use only the standard library and local modules. The supervisor imports replacement.run.',
  go: 'Use package replacement in src/. In src/replacement.go define func Run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int. Import io from the standard library. Use the standard library and, if needed, local packages under legacybridge.local/module/src. The supervisor imports legacybridge.local/module/src.',
  java: 'Use package legacybridge. In src/Replacement.java define public final class Replacement with public static int run(String[] args, java.io.InputStream stdin, java.io.OutputStream stdout, java.io.OutputStream stderr) throws Exception. Use the JDK and local classes.',
  csharp: 'Use namespace LegacyBridge. In src/Replacement.cs define public static class Replacement with public static int Run(string[] args, System.IO.Stream stdin, System.IO.Stream stdout, System.IO.Stream stderr). Use .NET standard libraries and local classes.',
};

export function generationTarget(language: TargetLanguage): GenerationRequest['target'] {
  const { runtime, entry, symbol } = targetOf(language);
  return { language, runtime, entry, export: symbol, allowRuntimeDeps: false, runContract: contracts[language] };
}
