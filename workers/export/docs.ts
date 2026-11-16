import type { ScopeDocV1 } from '@lb/contracts';
import { moduleFunctionDetails } from '../../lib/module-preview';

type Untranslated = { id: string; behavior_id: string | null; reason: string };

/**
 * docs.md: one section per function in the exported module. It is assembled from the source itself (signature, the comment written for
 * the function, the behaviors it is marked with) and the approved scope, so it needs no model call and carries no date: the same
 * module and scope always give the same file, which keeps SHA256SUMS stable.
 */
export function moduleDocs(i: { project: string; language: string; entry: string; symbol: string; scope: ScopeDocV1; untranslated: Untranslated[]; files: { path: string; content: string }[] }): string {
  const behaviors = new Map(i.scope.behaviors.map(b => [b.id, b]));
  const name = (id: string) => { const b = behaviors.get(id); return b ? (b.label || b.statement) : id; };
  const functions = moduleFunctionDetails(i.files);
  const out: string[] = [
    `# ${i.project}: module documentation`, '',
    `A ${i.language} replacement for the workflow "${i.scope.workflow.name}". The entry point is \`${i.symbol}\` in \`${i.entry}\`.`,
    'This file describes what each function does according to the comments in the code. It does not show that the replacement matches the original: see `results/` and `UNRESOLVED.md` for that.', '',
    '## Features', '',
    ...(i.scope.behaviors.length ? i.scope.behaviors.map(b => `- **${b.label || b.statement}** (${b.basis.replace(/_/g, ' ')})${b.label ? ': ' + b.statement : ''}`) : ['No features were recorded.']), '',
    `## Functions (${functions.length})`, '',
  ];
  if (!functions.length) out.push('No named functions were found in the source files.', '');
  for (const f of functions) {
    const implements_ = [...new Set(f.markers.filter(m => m.kind === 'BEHAVIOR').map(m => m.id))];
    const open = [...new Set(f.markers.filter(m => m.kind === 'UNTRANSLATED').map(m => m.id))];
    out.push(`### \`${f.name}\``, '', `\`${f.path}:${f.line}\``, '', '```', f.signature, '```', '',
      f.doc || '_No comment was written for this function._', '');
    if (implements_.length) out.push('Implements: ' + implements_.map(name).join('; ') + '.', '');
    if (open.length) out.push('Not fully translated: ' + open.join(', ') + ' (see the section below).', '');
  }
  out.push('## Not translated', '');
  if (!i.untranslated.length) out.push('Nothing was marked as untranslated.', '');
  for (const u of i.untranslated) out.push(`- **${u.id}**${u.behavior_id ? ' (' + name(u.behavior_id) + ')' : ''}: ${u.reason || 'no reason recorded'}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
