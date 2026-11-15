'use client';

import { useState } from 'react';
import { notExecutableMessage, readExecutableKind } from '@/lib/executable';
import { post, s1, sendArtifact, waitJob } from '@/lib/s1-client';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation, type SourceStatus } from './StageFrame';

export default function Import({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const source = project.heads.current_source_revision_id;
  const original = details.environments.find(e => e.role === 'original')?.id;
  const [primary, setPrimary] = useState<File>();
  const [support, setSupport] = useState<File[]>([]);
  const [notes, setNotes] = useState('');
  const [fileError, setFileError] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const { data, error } = useResource<SourceStatus>(source ? '/source-revisions/' + source : null, true);

  async function choosePrimary(input: HTMLInputElement) {
    const file = input.files?.[0];
    setFileError('');
    setPrimary(undefined);
    if (!file) return;
    if (!(await readExecutableKind(file).catch(() => null))) {
      input.value = '';
      setFileError(notExecutableMessage);
      return;
    }
    setPrimary(file);
  }
  function upload() {
    if (!primary) return;
    void op.run('Uploading and inspecting the executable…', async signal => {
      if (new Set([primary.name, ...support.map(f => f.name)]).size !== support.length + 1) {
        throw new Error('Each uploaded file must have a unique filename.');
      }
      const artifacts = [await sendArtifact(path, primary, 'bin/' + primary.name, 'primary_executable')];
      for (const file of support) {
        const library = /\.so(?:\.\d+)*$/.test(file.name);
        artifacts.push(await sendArtifact(path, file, (library ? 'lib/' : 'data/') + file.name, library ? 'shared_library' : 'data_file'));
      }
      const revision = await post<{ jobs: { id: string }[] }>(path + '/source-revisions', { artifacts, notes, parent_id: source });
      await refresh();
      await waitJob(revision.jobs[0].id, signal);
      await refresh();
      return 'Source revision inspected.';
    });
  }
  function probe() {
    if (!source || !original) return;
    void op.run('Running the execution probe in Docker…', async signal => {
      if (!details.source?.execution_consent_at) {
        await post('/source-revisions/' + source + '/execution-consent', { acknowledge: 'I am authorized to run this executable in an isolated sandbox.' });
      }
      const job = await post<{ job_id: string }>('/source-revisions/' + source + '/probe', { environment_id: original });
      await waitJob(job.job_id, signal);
      await refresh();
      const status = await s1<SourceStatus>('/source-revisions/' + source);
      return 'Execution probe finished: ' + status.eligibility.execution.status + '.';
    });
  }
  return <>
    <div className="panels">
      <section className="panel s1-fields">
        <label className="field">Legacy executable<input type="file" disabled={op.busy} onChange={e => void choosePrimary(e.target)} /></label>
        {fileError && <p role="alert">{fileError}</p>}
        <label className="field">Supporting files<input type="file" multiple disabled={op.busy} onChange={e => setSupport(Array.from(e.target.files ?? []))} /></label>
        <label className="field">Project context<textarea value={notes} maxLength={5000} onChange={e => setNotes(e.target.value)} /></label>
        <button className="primary" type="button" onClick={upload} disabled={!primary || op.busy}>Upload and inspect</button>
      </section>
      <section className="panel s1-fields">
        <h2>Source inspection</h2>
        {details.source && <p>{details.source.path}</p>}
        {data ? <>
          <p>Analysis: <strong>{data.eligibility.analysis.status}</strong> · Execution: <strong>{data.eligibility.execution.status}</strong></p>
          {data.inspection && <p>{data.inspection.format} · {data.inspection.arch} · {data.inspection.needed?.join(', ')}</p>}
          {data.eligibility.execution.reasons.length > 0 && <p className="hint">{data.eligibility.execution.reasons.map(reason => reason.replaceAll('_', ' ')).join(', ')}</p>}
          {!details.source?.execution_consent_at && <label className="s1-checkbox"><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} />I am authorized to run this executable in the sandbox.</label>}
          <button type="button" className="secondary" disabled={op.busy || !original || (!authorized && !details.source?.execution_consent_at) || !['eligible', 'partial'].includes(data.eligibility.analysis.status)} onClick={probe}>Probe original</button>
        </> : <p className="hint">{error || (source ? 'Inspection pending.' : 'Upload an ELF executable to see its format and dependencies.')}</p>}
      </section>
    </div>
    <Continue stage={1} />
  </>;
}
