'use client';

import { useState } from 'react';
import { BASES, DEPENDENCY_KINDS, DISPOSITIONS, newId, type Behavior, type Dependency, type Note, type Question, type Scope } from '@/lib/scope-doc';

type Props = { doc: Scope; onChange: (doc: Scope) => void; disabled: boolean };
const short = (id: string) => id.slice(0, 8);

function replaceAt<T>(list: T[] | undefined, index: number, patch: Partial<T>): T[] {
  return (list ?? []).map((item, i) => (i === index ? { ...item, ...patch } : item));
}
const without = <T,>(list: T[] | undefined, index: number) => (list ?? []).filter((_, i) => i !== index);

function Evidence({ ids, disabled, onRemove }: { ids: string[]; disabled: boolean; onRemove: (index: number) => void }) {
  if (!ids.length) return <p className="hint">No evidence cited. Use Cite in scope on a finding above.</p>;
  return <ul className="s3-chips" aria-label="Cited evidence">
    {ids.map((id, i) => <li key={id}><code title={id}>{short(id)}</code>
      <button type="button" className="secondary" disabled={disabled} aria-label={'Remove citation ' + short(id)} onClick={() => onRemove(i)}>Remove</button></li>)}
  </ul>;
}

export default function ScopeEditor({ doc, onChange, disabled }: Props) {
  const set = (patch: Partial<Scope>) => onChange({ ...doc, ...patch });
  const invocation = doc.workflow?.invocation ?? {};
  const [argv, setArgv] = useState<string | null>(null);
  const argvText = argv ?? (invocation.argv_template ?? []).join('\n');

  return <div className="s1-fields">
    <fieldset className="s3-group" disabled={disabled}>
      <legend>Workflow</legend>
      <label className="field">Name<input value={doc.workflow?.name ?? ''} maxLength={120} onChange={e => set({ workflow: { ...doc.workflow, name: e.target.value } })} /></label>
      <label className="field">Command-line arguments, one per line
        <textarea rows={2} spellCheck={false} value={argvText}
          onChange={e => { setArgv(e.target.value); set({ workflow: { ...doc.workflow, invocation: { ...invocation, argv_template: e.target.value.split('\n').filter(Boolean) } } }); }}
          onBlur={() => setArgv(null)} /></label>
      <label className="field">Standard input
        <select value={invocation.stdin ?? 'none'} onChange={e => set({ workflow: { ...doc.workflow, invocation: { ...invocation, stdin: e.target.value } } })}>
          <option value="none">None</option><option value="text">Text</option><option value="bytes">Bytes</option>
        </select></label>
    </fieldset>

    <fieldset className="s3-group" disabled={disabled}>
      <legend>What to modernize ({doc.behaviors?.length ?? 0})</legend>
      {(doc.behaviors ?? []).map((b: Behavior, i) => <div key={b.id} className="s3-item">
        <label className="field">Behavior<input value={b.statement} maxLength={400} onChange={e => set({ behaviors: replaceAt(doc.behaviors, i, { statement: e.target.value }) })} /></label>
        <label className="field">How we know
          <select value={b.basis} onChange={e => set({ behaviors: replaceAt(doc.behaviors, i, { basis: e.target.value }) })}>
            {BASES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        <label className="field">Notes<input value={b.notes ?? ''} onChange={e => set({ behaviors: replaceAt(doc.behaviors, i, { notes: e.target.value }) })} /></label>
        <Evidence ids={b.evidence ?? []} disabled={disabled} onRemove={j => set({ behaviors: replaceAt(doc.behaviors, i, { evidence: without(b.evidence, j) }) })} />
        <button type="button" className="secondary" onClick={() => set({ behaviors: without(doc.behaviors, i) })}>Remove behavior</button>
      </div>)}
      {!doc.behaviors?.length && <p className="hint">Nothing is in scope yet. Add a behavior, or cite a finding from the evidence above.</p>}
      <button type="button" className="secondary" onClick={() => set({ behaviors: [...(doc.behaviors ?? []), { id: newId('behavior'), statement: '', basis: 'observed', evidence: [] }] })}>Add behavior</button>
    </fieldset>

    <fieldset className="s3-group" disabled={disabled}>
      <legend>Dependencies ({doc.dependencies?.length ?? 0})</legend>
      <p className="hint">Time, randomness, environment, files and network that the program relies on. Say who is responsible in the replacement.</p>
      {(doc.dependencies ?? []).map((d: Dependency, i) => <div key={d.id} className="s3-item">
        <label className="field">Kind
          <select value={d.kind} onChange={e => set({ dependencies: replaceAt(doc.dependencies, i, { kind: e.target.value }) })}>
            {DEPENDENCY_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select></label>
        <label className="field">In the new code
          <select value={d.disposition} onChange={e => set({ dependencies: replaceAt(doc.dependencies, i, { disposition: e.target.value }) })}>
            {DISPOSITIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        <label className="field">Who is responsible now<input value={d.responsibility_change ?? ''} onChange={e => set({ dependencies: replaceAt(doc.dependencies, i, { responsibility_change: e.target.value }) })} /></label>
        <Evidence ids={d.evidence ?? []} disabled={disabled} onRemove={j => set({ dependencies: replaceAt(doc.dependencies, i, { evidence: without(d.evidence, j) }) })} />
        <button type="button" className="secondary" onClick={() => set({ dependencies: without(doc.dependencies, i) })}>Remove dependency</button>
      </div>)}
      <button type="button" className="secondary" onClick={() => set({ dependencies: [...(doc.dependencies ?? []), { id: newId('dependency'), kind: 'filesystem', disposition: 'explicit_input', evidence: [] }] })}>Add dependency</button>
    </fieldset>

    <NoteList legend="Assumptions" noun="assumption" items={doc.assumptions} disabled={disabled} onChange={assumptions => set({ assumptions })} />
    <NoteList legend="Decisions" noun="decision" items={doc.decisions} disabled={disabled} stamp onChange={decisions => set({ decisions })} />

    <fieldset className="s3-group" disabled={disabled}>
      <legend>Open questions ({(doc.open_questions ?? []).filter(q => q.status !== 'resolved').length} open)</legend>
      {(doc.open_questions ?? []).map((q: Question, i) => <div key={q.id} className="s3-item">
        <label className="field">Question<input value={q.text} onChange={e => set({ open_questions: replaceAt(doc.open_questions, i, { text: e.target.value }) })} /></label>
        <label className="field">Status
          <select value={q.status} onChange={e => set({ open_questions: replaceAt(doc.open_questions, i, { status: e.target.value as Question['status'], resolution: e.target.value === 'open' ? null : q.resolution ?? '' }) })}>
            <option value="open">Open</option><option value="resolved">Resolved</option>
          </select></label>
        {q.status === 'resolved' && <label className="field">Resolution<input value={q.resolution ?? ''} onChange={e => set({ open_questions: replaceAt(doc.open_questions, i, { resolution: e.target.value }) })} /></label>}
        <button type="button" className="secondary" onClick={() => set({ open_questions: without(doc.open_questions, i) })}>Remove question</button>
      </div>)}
      <button type="button" className="secondary" onClick={() => set({ open_questions: [...(doc.open_questions ?? []), { id: newId('question'), text: '', status: 'open', resolution: null }] })}>Add question</button>
    </fieldset>
  </div>;
}

function NoteList({ legend, noun, items, disabled, stamp, onChange }: { legend: string; noun: string; items: Note[] | undefined; disabled: boolean; stamp?: boolean; onChange: (items: Note[]) => void }) {
  return <fieldset className="s3-group" disabled={disabled}>
    <legend>{legend} ({items?.length ?? 0})</legend>
    {(items ?? []).map((n, i) => <div key={n.id} className="s3-item">
      <label className="field">{noun[0].toUpperCase() + noun.slice(1)}<input value={n.text} onChange={e => onChange(replaceAt(items, i, { text: e.target.value }))} /></label>
      <button type="button" className="secondary" onClick={() => onChange(without(items, i))}>Remove {noun}</button>
    </div>)}
    <button type="button" className="secondary" onClick={() => onChange([...(items ?? []), { id: newId(noun), text: '', ...(stamp ? { at: new Date().toISOString() } : {}) }])}>Add {noun}</button>
  </fieldset>;
}
