'use client';

import { ScopeDocV1 } from '@lb/contracts';
import { useState, type FormEvent } from 'react';
import type { IndexedFinding } from './EvidencePanel';

const bases = [
  ['inferred', 'Inferred'],
  ['observed', 'Observed'],
  ['customer_requirement', 'Customer requirement'],
  ['intentional_change', 'Intentional change'],
] as const;

function readDraft(text: string) {
  try {
    const document: unknown = JSON.parse(text);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
    const draft = document as Record<string, unknown>;
    const parsed = ScopeDocV1.shape.behaviors.safeParse(draft.behaviors);
    if (parsed.success) return { document: draft, behaviors: parsed.data };
  } catch { /* Keep invalid JSON editable in the scope document field. */ }
  return null;
}

export default function ScopeCitation({ finding, text, onApply, onCancel }: {
  finding: IndexedFinding;
  text: string;
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState('new');
  const [statement, setStatement] = useState('');
  const [basis, setBasis] = useState<string>('inferred');
  const draft = readDraft(text);
  const behaviorIndex = Number(selected);
  const current = draft?.behaviors[behaviorIndex];
  const alreadyCited = current?.evidence.includes(finding.id);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const original = (draft.document.behaviors ?? []) as Record<string, unknown>[];
    const trimmed = statement.trim();
    if (selected === 'new' && trimmed) {
      const behavior = { id: 'behavior-' + crypto.randomUUID(), statement: trimmed, basis, evidence: [finding.id] };
      onApply(JSON.stringify({ ...draft.document, behaviors: [...original, behavior] }, null, 2));
    } else if (current && !alreadyCited) {
      const behaviors = original.map((behavior, index) => index === behaviorIndex
        ? { ...behavior, evidence: [...current.evidence, finding.id] }
        : behavior);
      onApply(JSON.stringify({ ...draft.document, behaviors }, null, 2));
    }
  }

  return <form className="s1-fields s2-section s2-citation" onSubmit={apply}>
    <h3>Cite in scope</h3>
    <p>Finding <strong>{finding.name || finding.address || finding.kind}</strong></p>
    {!draft && <p role="alert">Correct the scope JSON and its behaviors before adding this citation.</p>}
    {!!draft?.behaviors.length && <label className="field">Scope behavior
      <select value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="new">New behavior</option>
        {draft.behaviors.map((behavior, index) => <option key={index} value={index}>{behavior.statement || behavior.id}</option>)}
      </select>
    </label>}
    {draft && selected === 'new' && <>
      <label className="field">Behavior statement
        <input required value={statement} onChange={event => setStatement(event.target.value)} />
      </label>
      <label className="field">Basis
        <select value={basis} onChange={event => setBasis(event.target.value)}>
          {bases.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </>}
    {alreadyCited && <p role="status">This behavior already cites the finding.</p>}
    <div className="s1-row">
      <button type="submit" className="secondary" disabled={!draft || (selected === 'new' ? !statement.trim() : !current || alreadyCited)}>Add citation</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel citation</button>
    </div>
  </form>;
}
