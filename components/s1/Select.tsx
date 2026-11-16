'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { projectPath } from '@/lib/projects';
import { post, s1, settleJob, waitJob } from '@/lib/s1-client';
import { emptyScope, newId, prune, type Scope } from '@/lib/scope-doc';
import { useS1Project } from './ProjectShell';
import { useResource, type Operation } from './StageFrame';

type Candidate = { title: string; findings: string[]; signals: string[] };
type Run = { id: string; kind: 'index' | 'deep_function'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; outcome: string | null; params?: { address?: string } };
type Draft = { version: number; document: Scope | null };
type Suggestion = { name: string; reason: string };

const signalText: Record<string, string> = { entry_point_name: 'main function', incoming_references: 'called from elsewhere' };
const MAX_PSEUDOCODE = 4;
/** What the analysis is doing, in the order it happens. Shown one line at a time while it runs; it is illustrative, not a live log. */
const ANALYSIS_STEPS = [
  'Loading the program into Ghidra…',
  'Reading the file format and sections…',
  'Finding where the code starts running…',
  'Listing the functions the compiler left behind…',
  'Following calls between functions…',
  'Collecting the text the program prints and checks…',
  'Turning machine code into readable pseudocode…',
  'Sorting the program’s own functions from the C runtime…',
  'Almost there. Large programs take a few minutes…',
];

/** Spinner plus a line of text that changes every few seconds. */
function AnalysisProgress() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep(n => Math.min(n + 1, ANALYSIS_STEPS.length - 1)), 4500);
    return () => clearInterval(timer);
  }, []);
  return <div className="analysis-progress" role="status">
    <span className="feature-indicator spinning" aria-hidden="true" />
    <span key={step} className="analysis-step">{ANALYSIS_STEPS[step]}</span>
  </div>;
}
/** Placeholder names a decompiler gives functions that have no symbol. Only these are named automatically. */
const UNNAMED = /^(FUN_|SUB_|0x)[0-9a-f]+$/i;

/** Suggested names are kept in this browser so reopening the page doesn't ask the model again. Approved labels live in the scope. */
function storedNames(sourceId: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('lb-function-names:' + sourceId) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function storeName(sourceId: string, id: string, name: string) {
  try { localStorage.setItem('lb-function-names:' + sourceId, JSON.stringify({ ...storedNames(sourceId), [id]: name })); } catch { /* names still show for this visit */ }
}

export default function Select({ op }: { op: Operation }) {
  const router = useRouter();
  const { project, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const sourceId = project.heads.current_source_revision_id;
  const sourcePath = '/source-revisions/' + sourceId;
  const runs = useResource<{ runs: Run[] }>(sourceId ? sourcePath + '/analysis-runs' : null, true);
  const index = runs.data?.runs.find(r => r.kind === 'index');
  const analysing = !index || index.status === 'queued' || index.status === 'running';
  const found = useResource<{ items: Candidate[]; run_id: string | null }>(sourceId && index?.status === 'succeeded' ? sourcePath + '/candidates' : null);
  const candidates = found.data?.items ?? [];
  const draft = useResource<Draft>(candidates.length ? path + '/scope-draft' : null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [editValue, setEditValue] = useState('');
  const [naming, setNaming] = useState<{ done: number; total: number } | 'unavailable' | null>(null);
  const chosen = candidates.filter(c => !off.has(c.findings[0]));
  const draftSettled = Boolean(draft.data || draft.error);

  // Unnamed functions get a name suggested from their pseudocode as soon as the list loads. It runs in the background: one model call per function.
  useEffect(() => {
    const items = found.data?.items ?? [];
    if (!sourceId || !items.length || !draftSettled) return;
    const saved = storedNames(sourceId);
    if (Object.keys(saved).length) setLabels(previous => ({ ...saved, ...previous }));
    const labelled = new Set(draft.data?.document?.behaviors?.filter(b => b.label).map(b => b.evidence[0]));
    const todo = items.map(c => c.findings[0]).filter((id, i) => UNNAMED.test(items[i].title) && !saved[id] && !labelled.has(id));
    if (!todo.length) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      try {
        setNaming({ done: 0, total: todo.length });
        let failed = false;
        for (const [i, id] of todo.entries()) {
          try {
            const job = await s1<{ job_id: string }>(path + '/function-name-suggestions', { method: 'POST', data: { finding_id: id }, signal });
            const result = await waitJob<{ suggestion: Suggestion | null } | null>(job.job_id, signal);
            const suggestion = result?.suggestion;
            if (suggestion) {
              storeName(sourceId, id, suggestion.name);
              setLabels(previous => (previous[id] === undefined ? { ...previous, [id]: suggestion.name } : previous));
            }
          } catch { signal.throwIfAborted(); failed = true; }
          setNaming({ done: i + 1, total: todo.length });
        }
        setNaming(failed ? 'unavailable' : null);
      } catch {
        if (!signal.aborted) setNaming('unavailable');
      }
    })();
    return () => controller.abort();
  }, [sourceId, found.data, draftSettled]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = chosen.length + extra.length;

  function definedLabel(id: string) {
    return labels[id] ?? draft.data?.document?.behaviors?.find(b => b.evidence[0] === id)?.label ?? '';
  }

  function finishRename(id: string) {
    if (editValue.trim()) {
      setLabels(previous => ({ ...previous, [id]: editValue.trim() }));
      if (sourceId) storeName(sourceId, id, editValue.trim());
    }
    setEditing(null);
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const name = typed.trim();
    if (name && !extra.includes(name)) setExtra([...extra, name]);
    setTyped('');
  }

  function next() {
    void op.run('Preparing…', async (signal, progress) => {
      // The import's analysis already decompiled every function. Only functions it missed (an older or partial analysis) are requested here.
      const have = new Set((await s1<{ items: { address: string | null }[] }>(sourcePath + '/findings?kind=pseudocode&limit=100', { signal }).catch(() => { signal.throwIfAborted(); return { items: [] }; })).items.map(f => f.address));
      for (const r of runs.data?.runs ?? []) if (r.kind === 'deep_function' && r.outcome === 'complete' && r.params?.address) have.add(r.params.address);
      const missing: { title: string; address: string }[] = [];
      for (const c of chosen) {
        const address = (await s1<{ address: string | null }>('/findings/' + c.findings[0], { signal })).address;
        if (address && !have.has(address)) missing.push({ title: c.title, address });
      }
      const todo = missing.slice(0, MAX_PSEUDOCODE);
      for (const [i, m] of todo.entries()) {
        progress('Reading ' + m.title + ' (' + (i + 1) + ' of ' + todo.length + ')… about a minute each.');
        const job = await post<{ job_id: string }>(sourcePath + '/analysis-runs', { kind: 'deep_function', params: { address: m.address } }).catch(() => null);
        signal.throwIfAborted();
        if (job) await settleJob(job.job_id, signal);
      }
      progress('Saving your selection…');
      const behaviors: NonNullable<Scope['behaviors']> = [];
      for (const c of chosen) {
        const label = definedLabel(c.findings[0]).trim();
        behaviors.push({ id: newId('feature'), ...(label ? { label } : {}), statement: 'Keep the behavior of ' + (label || c.title) + '.', basis: 'inferred', evidence: c.findings });
      }
      for (const text of extra) behaviors.push({ id: newId('feature'), statement: text, basis: 'customer_requirement', evidence: [] });
      const doc = prune({ ...emptyScope(project.name, project.target_language), behaviors });
      const draft = await s1<Draft>(path + '/scope-draft', { signal }).catch(() => { signal.throwIfAborted(); return { version: 0 }; });
      signal.throwIfAborted(); // nothing is written once the page has been left
      await s1(path + '/scope-draft', { method: 'PUT', headers: { 'if-match': '"v' + (draft?.version ?? 0) + '"' }, data: { document: doc } });
      const saved = await s1<Draft>(path + '/scope-draft');
      const revision = await post<{ id: string; document_sha256: string }>(path + '/scope-revisions', { from_draft_version: saved.version });
      await post('/scope-revisions/' + revision.id + '/decision', { decision: 'approved', document_sha256: revision.document_sha256 });
      await refresh();
      if (!signal.aborted) router.push(projectPath(project.id, 2));
      return 'Ready.';
    });
  }

  return <>
    <div className="panels">
      <section className="panel">
        <h2>Features found</h2>
        {!sourceId && <p className="hint">Upload an executable first.</p>}
        {sourceId && analysing && <AnalysisProgress />}
        {sourceId && index && (['failed', 'cancelled'].includes(index.status) || index.outcome === 'failed') && <p className="hint" role="status">The analysis didn’t finish. You can still type the features you want.</p>}
        {sourceId && index?.status === 'succeeded' && index.outcome !== 'failed' && found.data && !candidates.length && <p className="hint">Nothing obvious was found. Type the features you want.</p>}
        {found.error && <p role="alert">{found.error}</p>}
        {naming && naming !== 'unavailable' && <p className="hint" role="status">Naming functions from their pseudocode… {naming.done} of {naming.total}</p>}
        {naming === 'unavailable' && <p className="hint" role="status">Automatic names aren’t available right now. You can rename functions yourself.</p>}
        {!naming && candidates.some(c => UNNAMED.test(c.title) && definedLabel(c.findings[0]).trim()) && <p className="hint">Names were suggested by AI from each function’s pseudocode. Rename any that look wrong.</p>}
        <div className="checks">
          {candidates.map(c => {
            const id = c.findings[0];
            const label = definedLabel(id);
            return <div key={id}>
              <div className="function-label-row">
                <input type="checkbox" aria-label={'Select ' + (label.trim() || c.title)} checked={!off.has(id)} disabled={op.busy} onChange={e => { const n = new Set(off); if (e.target.checked) n.delete(id); else n.add(id); setOff(n); }} />
                {editing === id ? <input className="function-name-input" aria-label={'Name for ' + c.title} autoFocus
                  value={editValue} placeholder={label.trim() || c.title} maxLength={100} disabled={op.busy}
                  onChange={e => setEditValue(e.target.value)} onBlur={() => finishRename(id)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishRename(id); } if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }} />
                  : <span className="function-name" title={label.trim() ? 'Found in the program as ' + c.title : undefined}>{label.trim() || c.title}{c.signals.length ? ' · ' + c.signals.map(s => signalText[s] ?? s).join(', ') : ''}</span>}
                <button type="button" className="secondary" disabled={op.busy} aria-label={'Rename ' + c.title}
                  onClick={() => { setEditValue(''); setEditing(id); }}>Rename</button>
              </div>
            </div>;
          })}
          {extra.map(name => <label key={name}><input type="checkbox" checked disabled={op.busy} onChange={() => setExtra(extra.filter(x => x !== name))} />{name}</label>)}
        </div>
      </section>
      <section className="panel">
        <h2>Did we miss something?</h2>
        <form className="field" onSubmit={add}>
          <label htmlFor="feature">Feature to look for</label>
          <input id="feature" maxLength={200} placeholder="Describe a feature to look for" value={typed} disabled={op.busy} onChange={e => setTyped(e.target.value)} />
          <button className="secondary" type="submit" disabled={op.busy || !typed.trim()}>Add feature</button>
        </form>
      </section>
    </div>
    <div className="actions"><button className="primary" type="button" disabled={op.busy || analysing || naming !== null && naming !== 'unavailable' || !total} onClick={next}>Next</button></div>
  </>;
}
