'use client';

import { useEffect, useState } from 'react';
import { post, s1, waitJob } from '@/lib/s1-client';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation } from './StageFrame';

type Diagnostic = { file?: string | null; line?: number | null; code?: string; message?: string; severity?: 'warning' };
type ModuleStatus = {
  id: string; number: number; origin: 'generated' | 'user_edit' | 'customer_upload'; scope_revision_id: string;
  file_manifest: { path: string }[];
  untranslated: { id: string; behaviorId?: string; file?: string; line?: number; reason: string }[];
  generator: { provider?: string; model?: string; model_version?: string | null } | null;
  build: { status: string; diagnostics: Diagnostic[] };
};
const originLabel = { generated: 'Generated', user_edit: 'Edited by a person', customer_upload: 'Uploaded' } as const;
const where = (d: Diagnostic) => (d.file ? d.file + (d.line ? ':' + d.line : '') + ' ' : '') + (d.code ? d.code + ': ' : '') + (d.message ?? '');

export default function Modernize({ op }: { op: Operation }) {
  const { project, refresh } = useS1Project();
  const [files, setFiles] = useState<File[]>([]);
  const [instructions, setInstructions] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string; original: string } | null>(null);
  const current = project.heads.current_module_revision_id;
  const approved = project.heads.approved_scope_revision_id;
  const module = useResource<ModuleStatus>(current ? '/module-revisions/' + current : null, true);
  const mod = module.data;
  const errors = mod?.build.diagnostics.filter(d => d.severity !== 'warning') ?? [];
  const warnings = mod?.build.diagnostics.filter(d => d.severity === 'warning') ?? [];
  const outdated = !!mod && mod.scope_revision_id !== approved;

  useEffect(() => {
    if (!open || !current) { setContent(null); return; }
    const controller = new AbortController();
    s1<{ content: string }>('/module-revisions/' + current + '/files/' + open.split('/').map(encodeURIComponent).join('/'), { signal: controller.signal })
      .then(file => { if (!controller.signal.aborted) setContent({ path: open, text: file.content, original: file.content }); })
      .catch(() => { if (!controller.signal.aborted) setContent(null); });
    return () => controller.abort();
  }, [open, current]);

  function upload() {
    void op.run('Uploading and queuing the TypeScript build…', async () => {
      await post('/projects/' + project.id + '/module-revisions', {
        origin: 'customer_upload', scope_revision_id: approved,
        files: await Promise.all(files.map(async file => ({ path: 'src/' + file.name, content: await file.text() }))),
      });
      await refresh();
      return 'Module revision saved.';
    });
  }
  function generate(repair: boolean) {
    void op.run(repair ? 'Asking the model to repair the current module…' : 'Generating TypeScript from the approved scope…', async signal => {
      const job = await post<{ job_id: string }>('/projects/' + project.id + '/module-revisions', {
        origin: 'generated', scope_revision_id: approved, ...(repair && current ? { parent_id: current } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      await waitJob(job.job_id, signal);
      await refresh();
      return 'Generated a new module revision. Its build is queued.';
    });
  }
  function saveEdit() {
    if (!content || !current) return;
    void op.run('Saving your edit as a new revision…', async () => {
      await post('/projects/' + project.id + '/module-revisions', {
        origin: 'user_edit', scope_revision_id: approved, parent_id: current, changes: [{ path: content.path, content: content.text }],
      });
      setOpen(null);
      await refresh();
      return 'Saved as a new revision. Its build is queued.';
    });
  }

  return <>
    <section className="panel s1-panel s1-fields">
      <h2>Generate from the approved scope</h2>
      {!approved && <p className="hint">Approve a scope on Select first.</p>}
      <p className="hint">Sends the approved scope and the cited evidence to the model provider. Your organization must allow this; otherwise upload or edit a module instead.</p>
      <label className="field">What should it focus on or fix (optional)<textarea rows={2} maxLength={2000} value={instructions} onChange={e => setInstructions(e.target.value)} disabled={op.busy} /></label>
      <div className="s1-row">
        <button className="primary" type="button" disabled={op.busy || !approved} onClick={() => generate(false)}>Generate TypeScript</button>
        <button className="secondary" type="button" disabled={op.busy || !approved || !current} onClick={() => generate(true)}>Repair current module</button>
      </div>
    </section>

    <section className="panel s1-panel s1-fields">
      <h2>Current module</h2>
      {!current && <p className="hint">No module yet. Generate one, or upload your own below.</p>}
      {module.error && <p role="alert">{module.error}</p>}
      {mod && <>
        <p role="status">Revision {mod.number} · {originLabel[mod.origin]}{mod.generator?.model ? ' by ' + mod.generator.provider + ' ' + mod.generator.model : ''} · Build: {mod.build.status}</p>
        {outdated && <p role="alert">This module was built for an earlier scope revision. Generate or upload a module for the approved scope.</p>}
        {errors.length > 0 && <><h3>Build errors</h3><ul className="s2-notes">{errors.map((d, i) => <li key={i}>{where(d)}</li>)}</ul></>}
        {mod.untranslated.length > 0 && <><h3>Not translated</h3>
          <ul className="s2-notes">{mod.untranslated.map(u => <li key={u.id}><strong>{u.id}</strong>{u.behaviorId ? ' (behavior ' + u.behaviorId + ')' : ''}: {u.reason}{u.file ? ' · ' + u.file + (u.line ? ':' + u.line : '') : ''}</li>)}</ul></>}
        {warnings.length > 0 && <><h3>Warnings</h3><ul className="s2-notes">{warnings.map((d, i) => <li key={i}>{where(d)}</li>)}</ul></>}
        <h3>Files</h3>
        <ul className="s3-chips">{mod.file_manifest.map(f => <li key={f.path}><button type="button" className="secondary" aria-pressed={open === f.path} disabled={op.busy} onClick={() => setOpen(open === f.path ? null : f.path)}>{f.path}</button></li>)}</ul>
        {open && !content && <p role="status">Loading file…</p>}
        {content && <>
          <label className="field">{content.path}<textarea rows={16} spellCheck={false} value={content.text} onChange={e => setContent({ ...content, text: e.target.value })} disabled={op.busy} /></label>
          <div className="s1-row">
            <button type="button" className="primary" disabled={op.busy || content.text === content.original || !approved} onClick={saveEdit}>Save as new revision</button>
            <button type="button" className="secondary" disabled={op.busy} onClick={() => setOpen(null)}>Close</button>
          </div>
          <p className="hint">Every edit is a new revision and is built again. Earlier verification runs become stale.</p>
        </>}
      </>}
    </section>

    <section className="panel s1-panel s1-fields">
      <h2>Upload your own module</h2>
      <label className="field">Replacement TypeScript files<input type="file" accept=".ts" multiple disabled={op.busy} onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label>
      <p className="hint">Include index.ts with an exported run function.</p>
      <button className="primary" type="button" onClick={upload} disabled={op.busy || !files.length || !approved}>Upload and build module</button>
    </section>
    <Continue stage={3} />
  </>;
}
