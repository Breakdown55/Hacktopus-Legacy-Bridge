import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildReaAnalysisResult, canonicalReaAddress, normalizeDecompileAll, normalizeReaEvidence, selectIndexAddress,
  type ReaAnalysisResult, type ReaEvidenceKind, type ReaOperation,
} from './normalize';

export type { ReaAnalysisResult } from './normalize';

const TARGET = '/input/artifact';
const VERSIONS = { rea: '6.9.0', ghidra: '12.1' };
const MAX_OPERATION_BYTES = 8 * 1024 * 1024;
const REA = 'node /opt/rea/node_modules/rea-agents/scripts/rea.mjs';
const PREFLIGHT = 'mkdir -p "$HOME" && node -e \'process.exit(require("/opt/rea/node_modules/rea-agents/package.json").version === "6.9.0" ? 0 : 1)\'';
const ENTRYPOINT = `${PREFLIGHT} && exec ${REA} "$@"`;
// decompile-all writes one file per function. They stay on the container's tmpfs and come back on stdout as one JSON document
// ({ envelope, functions }), so the container still sees nothing of the host except the read-only artifact.
const PACK = 'const fs=require("fs");const ix=JSON.parse(fs.readFileSync("/tmp/lb-pc/decompile-index.json","utf8"));const functions=[];'
  + 'for(const f of ix.functions){if(f.status!=="written"||typeof f.relative_path!=="string")continue;'
  + 'functions.push({address:f.address,name:f.name,sha256:f.sha256,content:fs.readFileSync("/tmp/lb-pc/"+f.relative_path,"utf8")});}'
  + 'process.stdout.write(JSON.stringify({envelope:fs.readFileSync("/tmp/lb-envelope.json","utf8"),functions}));';
const DECOMPILE_ALL = `${PREFLIGHT} && ${REA} "$@" --output /tmp/lb-pc > /tmp/lb-envelope.json && exec node -e '${PACK}'`;

export interface AnalyzeOptions {
  targetPath: string;
  artifactSha256: string;
  address?: string;
  checkpoint?: (progress?: unknown) => Promise<void>;
}

export interface ReaAnalysisRunner {
  analyze(options: AnalyzeOptions): Promise<ReaAnalysisResult>;
}

type Execute = (bin: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<Buffer>;

interface DockerOptions {
  image: string;
  runtime?: string;
  docker?: string;
  timeoutMs?: number;
  execute?: Execute;
}

const execDocker: Execute = (bin, args, { timeoutMs, signal }) => new Promise((resolve, reject) => {
  execFile(bin, args, { encoding: 'buffer', maxBuffer: MAX_OPERATION_BYTES, timeout: timeoutMs, signal, windowsHide: true },
    (error, stdout) => {
      if (!error) resolve(stdout);
      else {
        const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.code
          : error.killed && !signal?.aborted ? 'ETIMEDOUT' : error.code;
        reject(Object.assign(new Error('analysis_command_failed'), { code }));
      }
    });
});

async function unsupportedReason(path: string): Promise<string | undefined> {
  const fd = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await fd.read(header);
    if (bytesRead >= 2 && header.toString('ascii', 0, 2) === 'MZ') return 'PE executables are outside the Linux ELF x86-64 analysis slice.';
    if (bytesRead < 64 || header.readUInt32BE(0) !== 0x7f454c46) return 'Native analysis requires a Linux ELF x86-64 executable.';
    if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62 || ![2, 3].includes(header.readUInt16LE(16))) {
      return 'Native analysis requires a little-endian x86-64 ELF executable or PIE.';
    }
  } finally {
    await fd.close();
  }
}

function command(kind: ReaEvidenceKind, address?: string): string[] {
  if (kind === 'procedures' || kind === 'strings') return ['search', TARGET, '.+', '--kind', kind, '--mode', 'regex'];
  if (kind === 'decompile_all') return ['decompile-all', TARGET];
  return [kind, TARGET, `ram:${address}`];
}

export class DockerReaAnalysisRunner implements ReaAnalysisRunner {
  private readonly execute: Execute;
  private readonly docker: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: DockerOptions) {
    this.execute = options.execute ?? execDocker;
    this.docker = options.docker ?? process.env.DOCKER_BIN ?? 'docker';
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
  }

  async analyze(input: AnalyzeOptions): Promise<ReaAnalysisResult> {
    const scope: 'inventory' | 'function' = input.address === undefined ? 'inventory' : 'function';
    const address = canonicalReaAddress(input.address);
    const versions = { ...VERSIONS, image: 'unresolved' };
    const base = { scope, artifactSha256: input.artifactSha256, versions };
    if (scope === 'function' && !address) return buildReaAnalysisResult({ ...base, outcome: 'failed', limitations: ['invalid_function_address'] });
    const reason = await unsupportedReason(input.targetPath);
    if (reason) return buildReaAnalysisResult({ ...base, outcome: 'unsupported', limitations: [reason] });

    await input.checkpoint?.({ phase: 'resolving_analysis_image' });
    const deadline = Date.now() + this.timeoutMs;
    try {
      const imageId = await this.execute(this.docker, ['image', 'inspect', '--format', '{{.Id}}', '--', this.options.image],
        { timeoutMs: Math.max(1, Math.min(10_000, this.timeoutMs)) });
      versions.image = imageId.toString('utf8').trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(versions.image)) throw new Error('invalid_image_id');
    } catch (error) {
      const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      return buildReaAnalysisResult({ ...base, versions: { ...VERSIONS, image: 'unresolved' },
        outcome: timedOut ? 'partial' : 'failed', limitations: [timedOut ? 'analysis_image_resolution_timeout' : 'analysis_image_unavailable'] });
    }

    const source = resolve(input.targetPath);
    if (/[,"\r\n]/.test(source)) return buildReaAnalysisResult({ ...base, outcome: 'failed', limitations: ['invalid_analysis_mount_path'] });
    const operations: ReaOperation[] = [];
    const run = async (kind: ReaEvidenceKind, selected?: string) => {
      await input.checkpoint?.({ phase: kind, address: selected });
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) {
        operations.push({ kind, address: selected, status: 'timeout' });
        return;
      }
      operations.push(await this.operation(input, source, versions.image, kind, timeoutMs, selected));
    };

    if (address) {
      await run('xrefs', address);
      await run('decompile', address);
    } else {
      await run('procedures');
      await run('strings');
      // One pass that decompiles every function, so nothing has to be requested per function later.
      await run('decompile_all');
      const selected = selectIndexAddress(operations[0]);
      if (selected) await run('xrefs', selected);
      else operations.push({ kind: 'xrefs', status: 'unavailable' });
    }
    return buildReaAnalysisResult({ ...base, operations });
  }

  private async operation(input: AnalyzeOptions, source: string, image: string, kind: ReaEvidenceKind,
    timeoutMs: number, address?: string): Promise<ReaOperation> {
    const controller = new AbortController();
    const name = `lb-rea-${randomUUID()}`;
    const args = [
      'run', '--rm', '--name', name, '--pull=never', '--platform=linux/amd64',
      '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--memory=8g', '--memory-swap=8g', '--cpus=4', '--pids-limit=256',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=1g,mode=1777',
      '--mount', `type=bind,src=${source},dst=${TARGET},readonly`,
    ];
    if (this.options.runtime) args.push(`--runtime=${this.options.runtime}`);
    args.push('--entrypoint=/bin/sh', image, '-c', kind === 'decompile_all' ? DECOMPILE_ALL : ENTRYPOINT, 'lb-rea', ...command(kind, address), '--provider', 'ghidra', '--json');

    let check: Promise<void> | undefined;
    let interrupted: unknown;
    const timer = setInterval(() => {
      if (check || interrupted || !input.checkpoint) return;
      check = input.checkpoint().catch((error: unknown) => {
        interrupted = error;
        controller.abort();
      }).finally(() => { check = undefined; });
    }, 5_000);
    let raw: Buffer | undefined;
    let status: 'failed' | 'timeout' | 'bounded' = 'failed';
    try {
      raw = await this.execute(this.docker, args, { timeoutMs, signal: controller.signal });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ETIMEDOUT') status = 'timeout';
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') status = 'bounded';
      try { await this.execute(this.docker, ['rm', '-f', name], { timeoutMs: 5_000 }); } catch { /* container may have exited */ }
    } finally {
      clearInterval(timer);
      await check;
    }
    if (interrupted) throw interrupted;
    if (!raw) return { kind, address, status };
    if (raw.length > MAX_OPERATION_BYTES) return { kind, address, status: 'bounded' };
    try {
      const evidence = kind === 'decompile_all' ? normalizeDecompileAll(raw, input.artifactSha256) : normalizeReaEvidence(raw, kind, input.artifactSha256, address);
      if (evidence.ghidraVersion === VERSIONS.ghidra) return { kind, address, status: 'complete', evidence };
    } catch { /* malformed evidence is never persisted */ }
    return { kind, address, status: 'invalid' };
  }
}
