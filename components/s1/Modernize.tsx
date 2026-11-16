'use client';

import { useEffect, useState } from 'react';
import { targetOf } from '@lb/contracts';
import { post, waitJob } from '@/lib/s1-client';
import { simpleQuestion } from '@/lib/module-preview';
import Icon from '../Icon';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation } from './StageFrame';

type Diagnostic = { file?: string | null; line?: number | null; code?: string; message?: string; severity?: 'warning' };
type ModuleStatus = {
  id: string; number: number; origin: 'generated' | 'user_edit' | 'customer_upload'; scope_revision_id: string;
  untranslated: { id: string; behaviorId?: string; question?: string; reason: string }[];
  generator?: { feature_states?: { id: string; state: string }[] } | null;
  build: { status: string; diagnostics: Diagnostic[] };
};
const buildLabel: Record<string, string> = { succeeded: 'Ready to test', failed: 'Needs a fix', error: 'Could not prepare the code', building: 'Preparing…', queued: 'Preparing…', not_built: 'Waiting to prepare' };
const where = (d: Diagnostic) => (d.file ? d.file + (d.line ? ':' + d.line : '') + ' ' : '') + (d.code ? d.code + ': ' : '') + (d.message ?? '');

export default function Modernize({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sample, setSample] = useState<{ name: string; text: string } | null>(null);
  const [sampleError, setSampleError] = useState('');
  const [sampleDragging, setSampleDragging] = useState(false);
  const [unknown, setUnknown] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const current = project.heads.current_module_revision_id;
  const approved = project.heads.approved_scope_revision_id;
  const module = useResource<ModuleStatus>(current ? '/module-revisions/' + current : null, true);
  const scope = useResource<{ document: { behaviors: { id: string; label?: string; statement: string }[] } }>(approved ? '/scope-revisions/' + approved : null);
  const mod = module.data;
  const outdated = !!mod && mod.scope_revision_id !== approved;
  const target = targetOf(project.target_language);
  useEffect(() => { setAnswers({}); setUnknown(new Set()); setSample(null); }, [current]);
  const reply = [instructions.trim(), ...(mod?.untranslated ?? []).filter(u => !unknown.has(u.id) && answers[u.id]?.trim()).map(u =>
    `Question (${u.id}): ${simpleQuestion(u.reason, u.question)}\nAnswer: ${answers[u.id].trim()}`)].filter(Boolean).join('\n\n');

  type Progress = { features?: { id: string; state: string }[] };
  const jobId = generationId ?? details.generation?.id ?? null;
  const generation = useResource<{ status: string; progress: Progress | null }>(jobId ? '/jobs/' + jobId : null, true);
  const generating = starting || ['queued', 'running'].includes(generation.data?.status ?? details.generation?.status ?? '');
  const busy = op.busy || generating;
  const features = scope.data?.document.behaviors ?? [];

  async function chooseSample(file: File | undefined) {
    setSample(null);
    setSampleError('');
    if (!file) return;
    try {
      if (file.size > 32000) throw new Error('Choose a small text example, up to 32 KB.');
      const text = await file.text();
      if (text.includes('\0')) throw new Error('Choose a text input file.');
      setSample({ name: file.name.slice(0, 200), text });
    } catch (error) { setSampleError((error as Error).message); }
  }

  function generate(repair: boolean) {
    void op.run(repair ? 'Regenerating your replacement…' : 'Creating your replacement…', async signal => {
      setStarting(true);
      setGenerationId(null);
      try {
        const notes = repair ? reply : instructions.trim();
        if (notes.length > 2000) throw new Error('Please shorten your answers and instructions to 2,000 characters in total.');
        const job = await post<{ job_id: string }>('/projects/' + project.id + '/module-revisions', {
          origin: 'generated', incremental: true, scope_revision_id: approved, ...(repair && current ? { parent_id: current } : {}), ...(notes ? { instructions: notes } : {}), ...(sample ? { sample_input: sample } : {}), ...(repair ? { unknown_questions: [...unknown] } : {}),
        });
        setGenerationId(job.job_id);
        await waitJob(job.job_id, signal);
        await refresh();
        return '';
      } finally { setStarting(false); }
    });
  }
  return <>
    <section className="panel s1-panel s1-fields">
      <h2>Create your replacement</h2>
      <p className="hint">Language: <strong>{target.label}</strong></p>
      {!approved && <p className="hint">Confirm your features on Select first.</p>}
      <h3>Selected features</h3>
      {scope.error && <p role="alert">{scope.error}</p>}
      {approved && !scope.data && !scope.error && <p role="status">Loading selected features…</p>}
      <ul className="generation-features" aria-label="Feature generation progress">
        {features.map(feature => {
          const live = generation.data?.progress?.features?.find(f => f.id === feature.id)?.state;
          const saved = !outdated ? mod?.generator?.feature_states?.find(f => f.id === feature.id)?.state : undefined;
          const rawState = generating ? (starting && !generationId ? 'queued' : live ?? 'queued') : generation.data?.status === 'failed' ? live ?? 'queued'
            : saved ?? (!outdated && mod ? mod.untranslated.some(u => u.behaviorId === feature.id) ? 'unresolved' : 'generated' : 'queued');
          const state = !generating && generation.data?.status === 'failed' && rawState === 'generating' ? 'interrupted' : rawState;
          const status = state === 'interrupted' ? 'Stopped' : state === 'generating' ? 'Generating…' : state === 'generated' ? 'Generated' : state === 'unresolved' ? 'Needs your input' : 'Waiting';
          return <li key={feature.id} className={'generation-feature ' + state}>
            <span className={'feature-indicator' + (state === 'generating' ? ' spinning' : '')} aria-hidden="true">{state === 'generated' ? '✓' : ''}</span>
            <span>{feature.label || feature.statement.replace(/^Keep the behavior of /, '').replace(/\.$/, '')}</span>
            <span className="feature-status">{status}</span>
          </li>;
        })}
      </ul>
      <label className="field">What should it focus on or change? (optional)<textarea rows={2} maxLength={2000} value={instructions} onChange={e => setInstructions(e.target.value)} disabled={busy} /></label>
      <div className="s1-row">
        <button className="primary" type="button" disabled={busy || !approved || !features.length || (!!current && reply.length > 2000)} onClick={() => generate(!!current)}>{current ? 'Regenerate' : 'Generate'} {target.name}</button>
      </div>
      {reply.length > 2000 && <p role="alert">Please shorten your answers and instructions to 2,000 characters in total.</p>}
      {module.error && <p role="alert">{module.error}</p>}
      {mod && mod.build.status !== 'succeeded' && <p role="status">{buildLabel[mod.build.status] ?? 'Preparing…'}</p>}
      {outdated && <p role="alert">Your selected features have changed. Regenerate before testing it.</p>}
      {mod && mod.build.diagnostics.length > 0 && <details><summary>Build details ({mod.build.diagnostics.length})</summary><ul className="s2-notes">{mod.build.diagnostics.map((d, i) => <li key={i}>{where(d)}</li>)}</ul></details>}
    </section>

    {mod && mod.untranslated.length > 0 && <section className="panel s1-panel s1-fields">
          <h3>A few questions for you</h3>
          <p className="hint">If you use the old program, share what you know or an example file. You can skip anything you don’t know and continue to Verify. Skipped parts stay unresolved.</p>
          {mod.untranslated.map(u => {
            return <div key={u.id} className="s1-fields">
              <label className="field">{simpleQuestion(u.reason, u.question)}<input type="text" value={answers[u.id] ?? ''} maxLength={1000} disabled={busy || unknown.has(u.id)} placeholder="Your answer or an example" onChange={e => setAnswers({ ...answers, [u.id]: e.target.value })} /></label>
              <button type="button" className="secondary" disabled={busy} aria-pressed={unknown.has(u.id)} onClick={() => setUnknown(previous => {
                const next = new Set(previous); if (next.has(u.id)) next.delete(u.id); else next.add(u.id); return next;
              })}>{unknown.has(u.id) ? 'Answer this question' : 'I don’t know'}</button>
              {unknown.has(u.id) && <p role="status" className="hint">Skipped · still unresolved. You can continue to Verify.</p>}
            </div>;
          })}
          <p>Example input file (optional)</p>
          <label className={'dropzone' + (sampleDragging ? ' drag' : '') + (busy ? ' disabled' : '') + (sample ? ' done' : '')}
            onDragOver={e => { e.preventDefault(); if (!busy) setSampleDragging(true); }}
            onDragLeave={() => setSampleDragging(false)}
            onDrop={e => { e.preventDefault(); setSampleDragging(false); if (!busy) void chooseSample(e.dataTransfer.files[0]); }}>
            <input type="file" aria-label="Example input file (optional)" accept=".txt,.csv,.tsv,.json,.dat,.log" disabled={busy}
              onChange={e => void chooseSample(e.target.files?.[0])} />
            <span className="drop-icon"><Icon name={sample ? 'check' : 'upload'} /></span>
            <span className="drop-main">{sample ? sample.name : 'Drag ’n’ drop an example input file here, or click to select a file'}</span>
            <span className="drop-sub">.txt, .csv, .tsv, .json, .dat, or .log · up to 32 KB</span>
          </label>
          {sample && <p role="status">{sample.name} is ready to use when you update the replacement.</p>}
          {sampleError && <p role="alert">{sampleError}</p>}
    </section>}

    <Continue stage={3} disabled={busy} />
  </>;
}
