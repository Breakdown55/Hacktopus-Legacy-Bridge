'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { projectPath } from '@/lib/projects';
import { post, s1, settleJob } from '@/lib/s1-client';
import { emptyScope, newId, prune, type Scope } from '@/lib/scope-doc';
import { useS1Project } from './ProjectShell';
import { useResource, type Operation } from './StageFrame';

type Candidate = { title: string; findings: string[]; signals: string[] };
type Run = { id: string; kind: 'index' | 'deep_function'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; outcome: string | null; params?: { address?: string } };
type Draft = { version: number };

const signalText: Record<string, string> = { entry_point_name: 'main function', incoming_references: 'called from elsewhere' };
const MAX_PSEUDOCODE = 4;

/** Features REA found in the executable (tick the ones to modernize), plus a box for features it missed. Nothing else. */
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
  const [off, setOff] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const chosen = candidates.filter(c => !off.has(c.title));
  const total = chosen.length + extra.length;

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
      for (const c of chosen) behaviors.push({ id: newId('feature'), statement: 'Keep the behavior of ' + c.title + '.', basis: 'inferred', evidence: c.findings });
      for (const text of extra) behaviors.push({ id: newId('feature'), statement: text, basis: 'customer_requirement', evidence: [] });
      const doc = prune({ ...emptyScope(project.name), behaviors });
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
        {sourceId && analysing && <p className="hint" role="status">Analyzing the executable…</p>}
        {sourceId && index && ['failed', 'cancelled'].includes(index.status) && <p className="hint" role="status">The analysis didn’t finish. You can still type the features you want.</p>}
        {sourceId && index?.status === 'succeeded' && !candidates.length && !found.error && <p className="hint">Nothing obvious was found. Type the features you want.</p>}
        {found.error && <p role="alert">{found.error}</p>}
        <div className="checks">
          {candidates.map(c => <label key={c.title}>
            <input type="checkbox" checked={!off.has(c.title)} disabled={op.busy} onChange={e => { const n = new Set(off); if (e.target.checked) n.delete(c.title); else n.add(c.title); setOff(n); }} />
            {c.title}{c.signals.length ? ' · ' + c.signals.map(s => signalText[s] ?? s).join(', ') : ''}
          </label>)}
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
    <div className="actions"><button className="primary" type="button" disabled={op.busy || !total} onClick={next}>Next</button></div>
  </>;
}
