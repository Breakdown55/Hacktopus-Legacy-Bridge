'use client';

import { useRef, useState } from 'react';
import { notExecutableMessage, readExecutableKind } from '@/lib/executable';
import { post, sendArtifact, settleJob, waitJob } from '@/lib/s1-client';
import Icon from '../Icon';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation, type SourceStatus } from './StageFrame';

/** Pick the program, confirm you may run it, upload. Inspection, the sandbox probe and the feature analysis all start by themselves. */
export default function Import({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const source = project.heads.current_source_revision_id;
  const original = details.environments.find(e => e.role === 'original')?.id;
  const [primary, setPrimary] = useState<File>();
  const [fileError, setFileError] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data } = useResource<SourceStatus>(source ? '/source-revisions/' + source : null, true);

  async function choose(file: File | undefined) {
    setFileError('');
    setPrimary(undefined);
    if (!file) return;
    if (!(await readExecutableKind(file).catch(() => null))) { if (input.current) input.current.value = ''; setFileError(notExecutableMessage); return; }
    setPrimary(file);
  }

  function upload() {
    if (!primary || !original) return;
    void op.run('Uploading…', async signal => {
      const artifact = await sendArtifact(path, primary, 'bin/' + primary.name, 'primary_executable');
      const revision = await post<{ id: string; jobs: { id: string }[] }>(path + '/source-revisions', { artifacts: [artifact], notes: '', parent_id: source });
      await refresh();
      await waitJob(revision.jobs[0].id, signal);
      // Everything after the upload is automatic. A failed probe or analysis does not block continuing.
      await post('/source-revisions/' + revision.id + '/execution-consent', { acknowledge: 'I am authorized to run this executable in an isolated sandbox.' }).catch(() => undefined);
      const probe = await post<{ job_id: string }>('/source-revisions/' + revision.id + '/probe', { environment_id: original }).catch(() => null);
      await post('/source-revisions/' + revision.id + '/analysis-runs', { kind: 'index' }).catch(() => undefined);
      if (probe) await settleJob(probe.job_id, signal);
      await refresh();
      return '';
    });
  }

  return <>
    <section className="panel s1-panel s1-fields">
      <h2>Upload your program</h2>
      <p className="hint">Drag and drop the executable here or click to browse.</p>
      <label className={'dropzone' + (dragging ? ' drag' : '') + (op.busy ? ' disabled' : '') + (primary ? ' done' : '')}
        onDragOver={e => { e.preventDefault(); if (!op.busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); if (!op.busy) void choose(e.dataTransfer.files[0]); }}>
        <input ref={input} type="file" disabled={op.busy} onChange={e => void choose(e.target.files?.[0])} />
        <span className="drop-icon"><Icon name={primary ? 'check' : 'upload'} /></span>
        {primary
          ? <span className="drop-main">{primary.name}</span>
          : <span className="drop-main">Drag ’n’ drop the executable here, or click to select a file</span>}
        <span className="drop-sub">.bin, .elf, .out, or a file with no extension</span>
      </label>
      {fileError && <p role="alert">{fileError}</p>}
      <label className="s1-checkbox"><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} />I’m allowed to run this program in a sandbox.</label>
      <button className="primary" type="button" onClick={upload} disabled={!primary || !authorized || !original || op.busy}>Upload</button>
      {details.source && <p className="hint">{details.source.path}{data?.inspection ? ' · ' + data.inspection.format + ' ' + data.inspection.arch : ''}</p>}
    </section>
    {project.progress.completed_steps >= 1
      ? <Continue stage={1} disabled={op.busy}>Next</Continue>
      : <div className="actions"><button type="button" className="primary" disabled>Next</button></div>}
  </>;
}
