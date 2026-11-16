/** A compact source inventory; this lists named declarations, not a call graph. */
export function moduleFunctions(files: { path: string; content: string }[]) {
  return files.filter(f => f.path.startsWith('src/')).flatMap(file => {
    // Keep line breaks while hiding comments and strings so examples don't become functions.
    const source = file.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '));
    const pattern = /\.py$/.test(file.path) ? /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm
      : /\.go$/.test(file.path) ? /^\s*func\s+(?:\([^\n)]*\)\s*)?(\w+)\s*(?:\[[^\n]*?\])?\(/gm
      : /\.(java|cs)$/.test(file.path) ? /^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|async|sealed|synchronized)\s+)*(?:[\w<>\[\],.?]+\s+)+(\w+)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?(?:\{|=>)/gm
      : /(?:\bfunction\s*\*?\s+(\w+)\s*(?:<[^>]*>)?\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^;]*?\)|\w+)\s*(?::[^=;]+)?=>)/g;
    return [...new Set([...source.matchAll(pattern)].map(m => m[1] || m[2]))].map(name => ({ name, path: file.path }));
  });
}

export function simpleQuestion(reason: string, question?: string) {
  if (/opcode|transaction dispatch|two.byte constants|record|two letters|short code|DAT_[0-9a-f]+/i.test(reason + ' ' + (question ?? ''))) return 'Do you have an example input file used by the old program? You can share a sample, or explain the format if you know it.';
  if (/encod|non-ASCII|bytes verbatim/i.test(reason)) return 'Can the input contain accented letters or other special characters? Please share an example and how it should appear in the result.';
  if (question?.trim()) return question.trim();
  if (/overflow|wraparound|wraps|integer width|signedness|2\^31/i.test(reason)) return 'What should happen when a calculation produces a very large number? A sample input and result would help.';
  if (/round|decimal|precision/i.test(reason)) return 'How should numbers be rounded? Please give an example of the result you expect.';
  if (/pars|whitespace|leading space/i.test(reason)) return 'What kinds of input should the program accept? Please give an example it should accept or reject.';
  if (/clock|time|date/i.test(reason)) return 'Which date or time should the program use? A real example would help.';
  if (/file|path|director/i.test(reason)) return 'Which files should the program read or create? Please describe an example.';
  return 'What should the program do in this situation? Please give a sample input and the result you expect, or say you’re not sure.';
}

export interface FunctionDetail { name: string; path: string; line: number; signature: string; doc: string; markers: { kind: 'BEHAVIOR' | 'UNTRANSLATED'; id: string }[] }

const COMMENT_LINE = /^\s*(?:\/\/\/?|\/\*\*?|\*\/?|#)/;
const MARKER = /LB-(BEHAVIOR|UNTRANSLATED):([\w.-]+)/g;

/** Every named function with its signature line, the comment written for it, and the LB-BEHAVIOR / LB-UNTRANSLATED markers in its body. */
export function moduleFunctionDetails(files: { path: string; content: string }[]): FunctionDetail[] {
  return files.filter(f => f.path.startsWith('src/')).flatMap(file => {
    const names = moduleFunctions([file]).map(f => f.name);
    if (!names.length) return [];
    const lines = file.content.split('\n');
    const starts = names.map(name => {
      const at = lines.findIndex(l => new RegExp('(?:\\bfunction\\s*\\*?\\s+|\\bdef\\s+|\\bfunc\\s+(?:\\([^)]*\\)\\s*)?|\\b(?:const|let)\\s+|[\\w>\\]]\\s+)' + name.replace(/[$]/g, '\\$&') + '\\s*(?:[(=<:])').test(l) && !COMMENT_LINE.test(l));
      return { name, at };
    }).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
    return starts.map(({ name, at }, i) => {
      const next = starts[i + 1]?.at ?? lines.length;
      let from = at;
      while (from > 0 && (COMMENT_LINE.test(lines[from - 1]) || /^\s*(?:@\w|\[\w)/.test(lines[from - 1]))) from--;
      const above = lines.slice(from, at).filter(l => !/^\s*(?:@\w|\[\w)/.test(l));
      let doc = above.map(l => l.replace(/^\s*(?:\/\/\/?|\/\*\*?|\*\/?|#)\s?/, '').replace(/\s*\*\/\s*$/, '')).filter(l => !/LB-(BEHAVIOR|UNTRANSLATED):/.test(l)).join('\n').trim();
      if (!doc && /\.py$/.test(file.path)) {
        const m = lines.slice(at + 1, at + 40).join('\n').match(/^\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')/);
        if (m) doc = m[1].replace(/^\s+/gm, '').trim();
      }
      const markers = [...lines.slice(from, next).join('\n').matchAll(MARKER)].map(m => ({ kind: m[1] as 'BEHAVIOR' | 'UNTRANSLATED', id: m[2] }));
      return { name, path: file.path, line: at + 1, signature: lines[at].trim().replace(/\s*[{:]\s*$/, ''), doc, markers };
    });
  });
}
