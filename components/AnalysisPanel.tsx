'use client';

import { useEffect, useRef, useState } from 'react';
import { MAX_ANALYSIS_BYTES, type AnalysisStatus } from '@/lib/codex-analysis';
import type { Project } from '@/lib/types';

const KEY = 'legacy-bridge-analysis-access';

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.title || 'Analysis request failed');
  return body as T;
}

export default function AnalysisPanel({ project, file, onQueued, onCandidates }: {
  project: Project;
  file?: File | null;
  onQueued?: (id: string) => void;
  onCandidates: (names: string[]) => void;
}) {
  const [key, setKey] = useState('');
  const [job, setJob] = useState<AnalysisStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submission = useRef<AbortController>(null);
  const jobId = project.analysisJobId;
  const active = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    setKey(sessionStorage.getItem(KEY) ?? '');
    return () => submission.current?.abort();
  }, []);

  useEffect(() => {
    if (!key || !jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const response = await fetch('/api/codex/jobs?id=' + encodeURIComponent(jobId!), {
          headers: { authorization: 'Bearer ' + key }, signal: controller.signal, cache: 'no-store',
        });
        const status = await readResponse<AnalysisStatus>(response);
        if (controller.signal.aborted) return;
        setJob(status);
        setMessage('');
        if (status.status === 'queued' || status.status === 'running') timer = setTimeout(poll, 2500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : 'Could not check analysis status.');
        timer = setTimeout(poll, 6000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, key]);

  async function submit() {
    if (!file || !key || busy || active) return;
    if (file.size > MAX_ANALYSIS_BYTES) return setMessage('Choose an executable no larger than 16 MiB.');
    const controller = new AbortController();
    submission.current = controller;
    setBusy(true);
    setMessage('');
    try {
      const context = [project.description, project.notes].filter(Boolean).join('\n').slice(0, 500).toWellFormed();
      const response = await fetch('/api/codex/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/octet-stream',
          'x-lb-context': encodeURIComponent(context),
        },
        body: file,
        signal: controller.signal,
      });
      const data = await readResponse<{ id: string }>(response);
      if (controller.signal.aborted) return;
      setJob({ status: 'queued' });
      onQueued?.(data.id);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Could not queue analysis.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function changeKey(value: string) {
    setKey(value);
    setJob(null);
    setMessage('');
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  }

  const status = job?.status === 'queued' ? 'Queued. Waiting for the processing laptop.'
    : job?.status === 'running' ? 'Analyzing on the processing laptop.'
    : job?.status === 'succeeded' ? 'Static analysis complete.'
    : job?.status === 'cancelled' ? 'Analysis cancelled.'
    : job?.status === 'failed' ? ({
      artifact_download_failed: 'The worker could not download the executable.',
      rea_failed: 'REA/Ghidra could not inspect the executable. Check the worker setup and executable format.',
      codex_failed: 'Codex could not complete the analysis. Check the worker login and usage allowance.',
      invalid_result: 'Codex returned unusable analysis results.',
      worker_lost: 'The processing laptop stopped responding.',
    }[job.error ?? ''] ?? 'Analysis failed.')
    : jobId && key ? 'Checking analysis status…' : '';
  const newCandidates = job?.result?.candidates.map(c => c.name).filter(name => !project.features.includes(name)) ?? [];

  return (
    <section className="panel analysis-panel">
      <div className="analysis-title"><h2>Codex analysis</h2>
        {onQueued && <button type="button" className="primary" onClick={submit} disabled={!file || !key || busy || active}>
          {busy ? 'Uploading…' : 'Analyze executable'}
        </button>}
      </div>
      <label className="field">
        Analysis access key
        <input type="password" autoComplete="off" value={key} onChange={e => changeKey(e.target.value.trim())} />
      </label>
      {!file && !jobId && <p className="hint">Choose an executable to submit it to a configured worker.</p>}
      <p role="status">{message || status}</p>
      {job?.result && (
        <div className="analysis-result">
          <p>{job.result.summary}</p>
          {!!job.result.candidates.length && (
            <>
              <h3>Candidate functionality</h3>
              <ul>{job.result.candidates.map((candidate, i) => (
                <li key={i}><strong>{candidate.name}</strong><p className="hint">{candidate.evidence}</p></li>
              ))}</ul>
              <button type="button" className="secondary" onClick={() => onCandidates(newCandidates)} disabled={!newCandidates.length}>
                Add candidates to Select
              </button>
            </>
          )}
          {!!job.result.limitations.length && <><h3>Limitations</h3><ul>{job.result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
        </div>
      )}
    </section>
  );
}
