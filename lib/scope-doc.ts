import { targetOf } from '@lb/contracts';

/** Working copy of a scope document (ScopeDocV1). Unknown sections (inputs, outputs, required_state, intentional_changes) pass through untouched. */
export type Scope = Record<string, unknown> & {
  workflow?: { name?: string; invocation?: { argv_template?: string[]; stdin?: string } };
  behaviors?: Behavior[]; dependencies?: Dependency[]; assumptions?: Note[]; decisions?: Note[]; open_questions?: Question[];
};
export type Behavior = { id: string; label?: string; statement: string; basis: string; evidence: string[]; notes?: string };
export type Dependency = { id: string; kind: string; disposition: string; responsibility_change?: string; evidence: string[] };
export type Note = { id: string; text: string; at?: string };
export type Question = { id: string; text: string; status: 'open' | 'resolved'; resolution: string | null };

export const BASES = [['observed', 'Observed'], ['inferred', 'Inferred'], ['customer_requirement', 'Customer requirement'], ['intentional_change', 'Intentional change']] as const;
export const DEPENDENCY_KINDS = ['time', 'random', 'env', 'filesystem', 'network'] as const;
export const DISPOSITIONS = [['explicit_input', 'Becomes an explicit input'], ['preserved', 'Preserved as is'], ['removed', 'Removed']] as const;

export function emptyScope(name: string, language?: string): Scope {
  const target = targetOf(language);
  return {
    workflow: { name, invocation: { argv_template: [], stdin: 'text' } },
    interface: { language: target.id, export: target.symbol },
    behaviors: [], dependencies: [], assumptions: [], decisions: [], open_questions: [],
  };
}
export const newId = (prefix: string) => prefix + '-' + Math.random().toString(36).slice(2, 10);

/** Reasons the document cannot be approved yet. The server enforces at least one behavior; the other checks are advice for the form. */
export function approvalBlockers(doc: Scope | null | undefined): string[] {
  const out: string[] = [];
  if (!doc?.behaviors?.length) out.push('Add at least one behavior to modernize.');
  else if (doc.behaviors.some(b => !b.statement.trim())) out.push('Every behavior needs a statement.');
  if (!doc?.workflow?.name?.trim()) out.push('Name the workflow.');
  return out;
}

export const openQuestions = (doc: Scope | null | undefined) => (doc?.open_questions ?? []).filter(q => q.status !== 'resolved');

/** Drops rows the user added but never filled in, so blanks are not sealed into a revision. */
export function prune(doc: Scope): Scope {
  const notes = (list?: Note[]) => (list ?? []).filter(n => n.text.trim());
  return {
    ...doc,
    behaviors: (doc.behaviors ?? []).filter(b => b.statement.trim() || b.evidence?.length),
    assumptions: notes(doc.assumptions), decisions: notes(doc.decisions),
    open_questions: (doc.open_questions ?? []).filter(q => q.text.trim()),
  };
}
