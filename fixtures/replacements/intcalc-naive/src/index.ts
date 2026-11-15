/**
 * NAIVE replacement for fixtures/src/intcalc.c, used by S5 verification tests. It is deliberately imperfect:
 *  - it truncates to two decimals instead of rounding (a tiny, numeric difference a tolerance policy can cover)
 *  - it uses exact JS addition, so 32-bit wraparound is NOT reproduced (a real difference no tolerance should hide)
 * Argument parsing and the exit-2 usage path match the original.
 */
export interface RunInput { argv: string[]; stdin: Uint8Array; env: Record<string, string | undefined> }
export interface RunDeps { cwd: string }
export interface RunOutput { stdout?: string; stderr?: string; exitCode?: number }

const USAGE: RunOutput = { stderr: 'usage: intcalc LEFT RIGHT\n', exitCode: 2 };

function parse(text: string): number | null {
  if (!/^\s*[+-]?\d+$/.test(text)) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

export async function run(input: RunInput, _deps: RunDeps): Promise<RunOutput> {
  if (input.argv.length !== 2) return USAGE;
  const left = parse(input.argv[0]);
  const right = parse(input.argv[1]);
  if (left === null || right === null) return USAGE;
  const value = Math.trunc(((left + right) / 3) * 100) / 100;
  return { stdout: value.toFixed(2) + '\n' };
}
