import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { DockerReaAnalysisRunner } from '../../workers/analysis/rea/runner';

type Measurement = {
  operation: 'procedures' | 'strings' | 'xrefs' | 'decompile';
  address: string | null;
  wall_ms: number;
  peak_bytes: number | null;
  peak_source: 'cgroup-v2' | 'cgroup-v1' | null;
  exit_code: number | string | null;
};

const marker = '__LB_F3_CGROUP_PEAK__';
const measureOnExit = `
report_peak() {
  while IFS=: read -r hierarchy controllers group; do
    if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then
      scope=cgroup-v2
      path="/sys/fs/cgroup$group/memory.peak"
    else
      case ",$controllers," in
        *,memory,*) scope=cgroup-v1; path="/sys/fs/cgroup/memory$group/memory.max_usage_in_bytes" ;;
        *) continue ;;
      esac
    fi
    if [ -r "$path" ] && read -r peak < "$path"; then
      case "$peak" in
        ''|*[!0-9]*) ;;
        *) printf '\\n%s %s %s\\n' '${marker}' "$scope" "$peak" >&2; return ;;
      esac
    fi
  done < /proc/self/cgroup
}
trap 'code=$?; report_peak; exit "$code"' 0
`;

/** Instrument the existing run in its own cgroup without new mounts, privileges, or stdout data. */
export function createMeasuredReaRunner(options: { image: string; docker?: string }) {
  const measurements: Measurement[] = [];
  const runner = new DockerReaAnalysisRunner({
    ...options,
    execute: (bin, args, { timeoutMs, signal }) => {
      let measurement: Measurement | undefined;
      if (args[0] === 'run') {
        const shell = args.indexOf('--entrypoint=/bin/sh');
        const command = args[shell + 5];
        const operation = command === 'search' ? args[args.indexOf('--kind', shell + 5) + 1] : command;
        const script = args[shell + 3];
        if (shell === -1 || !script?.includes('&& exec node ') ||
          (operation !== 'procedures' && operation !== 'strings' && operation !== 'xrefs' && operation !== 'decompile')) {
          return Promise.reject(new Error('Unable to measure this REA Docker command'));
        }
        args = [...args];
        // Keep the shell alive until the REA child exits so it can read the cgroup peak.
        args[shell + 3] = measureOnExit + script.replace('&& exec node ', '&& node ');
        measurement = {
          operation, address: command === 'search' ? null : args[shell + 7],
          wall_ms: 0, peak_bytes: null, peak_source: null, exit_code: null,
        };
      }
      const started = performance.now();
      return new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, signal, windowsHide: true },
          (error, stdout, stderr) => {
            const code = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.code
              : error?.killed && !signal?.aborted ? 'ETIMEDOUT' : error?.code;
            if (measurement) {
              const peak = stderr.toString('utf8').match(new RegExp(`^${marker} (cgroup-v[12]) ([0-9]+)\\r?$`, 'm'));
              const bytes = Number(peak?.[2]);
              measurement.wall_ms = Math.round(performance.now() - started);
              measurement.exit_code = error ? code ?? error.signal ?? 'unknown' : 0;
              if (peak && Number.isSafeInteger(bytes) && bytes > 0) {
                measurement.peak_bytes = bytes;
                measurement.peak_source = peak[1] === 'cgroup-v2' ? 'cgroup-v2' : 'cgroup-v1';
              }
              measurements.push(measurement);
            }
            if (error) reject(Object.assign(new Error('analysis_command_failed'), { code }));
            else resolve(stdout);
          });
      });
    },
  });
  return { runner, measurements };
}
