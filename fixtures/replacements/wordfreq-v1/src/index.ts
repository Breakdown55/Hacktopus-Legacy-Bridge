import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** TypeScript replacement for fixtures/src/wordfreq.c. Mirrors the C semantics (ASCII letters only, 63-char words, 4096 distinct words). */
export interface RunInput { argv: string[]; stdin: Uint8Array; env: Record<string, string | undefined> }
export interface RunDeps { cwd: string }
export interface RunOutput { stdout?: string; stderr?: string; exitCode?: number }

const USAGE: RunOutput = { stderr: 'usage: wordfreq [--top N]\n', exitCode: 2 };
const MAXW = 4096;

// C atoi: optional leading whitespace and sign, then digits; anything else yields 0.
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? Number(m[1]) | 0 : 0;
}

export async function run(input: RunInput, deps: RunDeps): Promise<RunOutput> {
  let top = 10;
  const a = input.argv;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--top' && i + 1 < a.length) {
      top = atoi(a[++i]);
      if (top < 1 || top > 1000) return USAGE;
    } else return USAGE;
  }
  let stop = new Set<string>();
  try {
    stop = new Set(readFileSync(join(deps.cwd, 'stopwords.txt'), 'latin1').split(/\s+/).filter(Boolean).slice(0, MAXW));
  } catch {
    /* no stopwords file */
  }
  const counts = new Map<string, number>();
  let word = '';
  const flush = () => {
    if (!word) return;
    if (!stop.has(word)) {
      if (counts.has(word)) counts.set(word, counts.get(word)! + 1);
      else if (counts.size < MAXW) counts.set(word, 1);
    }
    word = '';
  };
  for (const b of input.stdin) {
    const lower = b | 0x20;
    if (lower >= 0x61 && lower <= 0x7a) {
      if (word.length < 63) word += String.fromCharCode(lower);
    } else flush();
  }
  flush();
  const rows = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { stdout: rows.slice(0, top).map(([w, n]) => `${w} ${n}\n`).join('') };
}
