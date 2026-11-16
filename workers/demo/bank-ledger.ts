/**
 * Demo replay for a project named "Bank Ledger" (development only, behind LB_DEMO_REPLAY=1).
 *
 * The real analysis and generation of the bankledger fixture take minutes. For a live demo, the worker replays what those steps
 * produced in an earlier real run (fixtures/demo/bank-ledger) after a short wait. Everything downstream is unchanged and real:
 * findings are normalized and stored by the normal analysis handler, the module is validated, built, run and compared as usual.
 *
 * A job is replayed only when the project is named "Bank Ledger" and its executable is byte-identical to the recorded one.
 * Replayed modules are stored with provider "recording", so an export never presents a replay as a fresh model run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../../server/jobs/queue';
import { DockerReaAnalysisRunner } from '../analysis/rea/runner';
import type { CodeGenerator, EvidenceItem, GenerationRequest, GenerationResult, Untranslated } from '../generation/provider';
import type { WorkerEnv } from '../runtime';

type RecordedModule = Pick<GenerationResult, 'files' | 'untranslated' | 'notes' | 'testCases'>;
export interface DemoRecording {
  artifact_sha256: string;
  rea: { image: string; calls: { op: string; address?: string; file: string }[] };
  /** Function address -> the name the model suggested for it. */
  names: Record<string, { name: string; reason: string } | null>;
  generation: {
    model: string;
    /** Behavior id used in the recorded files -> the address of the function that behavior was selected from. */
    behaviors: Record<string, string>;
    /** What generation returned first (it has a question), and what it returned once the question was answered. */
    first: RecordedModule;
    resolved: RecordedModule;
  };
}

export const DEMO_PROJECT_NAME = 'bank ledger';
const ANALYSIS_STEP_MS = 1800;
const NAME_MS = 600;
const GENERATION_MS = 12_000;

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function loadRecording(dir: string): DemoRecording | undefined {
  const file = join(dir, 'recording.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as DemoRecording : undefined;
}

/** The normal analysis runner, fed the recorded container output instead of starting Ghidra. Normalization and storage run as usual. */
export function replayAnalysisRunner(recording: DemoRecording, dir: string, stepMs = ANALYSIS_STEP_MS) {
  return new DockerReaAnalysisRunner({
    image: recording.rea.image,
    execute: async (_bin, args, { signal }) => {
      if (args[0] === 'image') return Buffer.from(recording.rea.image + '\n');
      if (args[0] === 'rm') return Buffer.alloc(0);
      const op = args.includes('decompile-all') ? 'decompile_all' : ['procedures', 'strings', 'xrefs', 'decompile'].find(name => args.includes(name));
      const address = args.find(a => a.startsWith('ram:'))?.slice(4);
      const call = recording.rea.calls.find(c => c.op === op && (c.address ?? undefined) === address);
      if (!call) throw Object.assign(new Error('not recorded'), { code: 'ENOENT' });
      await sleep(stepMs, signal);
      return readFileSync(join(dir, 'rea', call.file));
    },
  });
}

/** Points the recorded module at the behaviors of the scope being generated: the same function, whatever id it has this time. */
export function remap(recorded: RecordedModule, recordedBehaviors: Record<string, string>, req: GenerationRequest): RecordedModule {
  const addressOf = new Map(req.evidence.filter(e => e.kind === 'function' && e.address).map(e => [e.findingId, e.address!]));
  const current = new Map<string, { id: string; evidence: string[] }>();
  for (const b of req.scope.document.behaviors) {
    const address = b.evidence.map(id => addressOf.get(id)).find(Boolean);
    if (address && !current.has(address)) current.set(address, { id: b.id, evidence: b.evidence.slice(0, 1) });
  }
  const to = (id: string) => current.get(recordedBehaviors[id] ?? '');
  const marker = /LB-BEHAVIOR:([\w.-]+)/g;
  const files = recorded.files.map(f => ({ path: f.path, content: f.content.replace(marker, (all, id: string) => {
    if (!(id in recordedBehaviors)) return all;
    return to(id) ? 'LB-BEHAVIOR:' + to(id)!.id : 'feature not selected';
  }) }));
  const untranslated = recorded.untranslated.flatMap((u): Untranslated[] => {
    if (u.behaviorId === undefined) return [{ ...u, evidence: [] }];
    const target = to(u.behaviorId);
    return target ? [{ ...u, behaviorId: target.id, evidence: target.evidence }] : [];
  });
  return { ...recorded, files, untranslated };
}

export class ReplayGenerator implements CodeGenerator {
  constructor(private readonly recording: DemoRecording, private readonly timing = { generationMs: GENERATION_MS, nameMs: NAME_MS }) {}

  describe() { return { provider: 'recording', model: 'bank-ledger-demo (recorded from ' + this.recording.generation.model + ')' }; }

  async suggestFunctionName(evidence: EvidenceItem[], signal: AbortSignal) {
    const address = evidence.find(e => e.address)?.address;
    await sleep(this.timing.nameMs, signal);
    return (address && this.recording.names[address]) || null;
  }

  async generate(req: GenerationRequest, { signal }: { signal: AbortSignal; job?: Job }): Promise<GenerationResult> {
    // One call per feature when generation is incremental, otherwise a single call: either way the whole run takes about the same time.
    const steps = req.activeBehaviorId ? Math.max(1, req.scope.document.behaviors.length) : 1;
    await sleep(Math.max(300, Math.round(this.timing.generationMs / steps)), signal);
    // The question counts as answered when this is an update of an earlier version that carries an answer or an example input file.
    const answered = !!req.priorRevision && (/\bAnswer:\s*\S/.test(req.instructions ?? '') || !!req.sampleInput);
    const pass = answered ? 'resolved' : 'first';
    const module = remap(this.recording.generation[pass], this.recording.generation.behaviors, req);
    return {
      ...module, usage: { inputTokens: 0, outputTokens: 0 },
      transcript: { replayed: 'fixtures/demo/bank-ledger', pass, recorded_model: this.recording.generation.model },
    };
  }
}

/**
 * Returns the worker environment a job should run with: the replay runner and generator for the demo project, the normal ones otherwise.
 * Undefined when no recording is present.
 */
export function bankLedgerDemo(dir: string): ((env: WorkerEnv, job: Job) => Promise<WorkerEnv>) | undefined {
  const recording = loadRecording(dir);
  if (!recording) return undefined;
  const rea = replayAnalysisRunner(recording, dir);
  const generator = new ReplayGenerator(recording);
  return async (env, job) => {
    if (!['native_index', 'suggest_function_name', 'generate'].includes(job.kind) || !job.project_id) return env;
    // The index job names its source revision; naming and generation use the project's current one.
    const rows = await env.db.query(
      `SELECT 1 FROM projects p JOIN source_artifacts a ON a.org_id=p.org_id AND a.role='primary_executable'
         AND a.source_revision_id = COALESCE($3::uuid, p.current_source_revision_id)
       WHERE p.id=$1 AND p.org_id=$2 AND p.deleted_at IS NULL AND lower(btrim(p.name))=$4 AND a.blob_sha256=$5`,
      [job.project_id, job.org_id, job.kind === 'native_index' ? job.subject_id : null, DEMO_PROJECT_NAME, recording.artifact_sha256]);
    if (!rows.length) return env;
    return job.kind === 'native_index' ? { ...env, rea } : { ...env, generator };
  };
}
