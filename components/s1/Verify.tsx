'use client';

import { useEffect, useState } from 'react';
import { post, s1, s1Local, waitJob } from '@/lib/s1-client';
import { checkReplacement, captureProblem, type CaptureProgress } from '@/lib/verification-flow';
import { downloadBlob } from '@/lib/download';
import { useS1Project } from './ProjectShell';
import { Continue, Spinner, useResource, type Operation, type SourceStatus } from './StageFrame';
const channelLabels: Record<string, string> = { stdout: 'Output', stderr: 'Messages', exit: 'Exit result', files: 'Files' };
type Result = { test_case_id: string; outcome: string; differences: { channel: string; kind: string }[] };

export default function Verify({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const original = details.environments.find(e => e.role === 'original')?.id;
  const replacement = details.environments.find(e => e.role === 'replacement')?.id;
  const [preparing, setPreparing] = useState(true);
  const [prepareError, setPrepareError] = useState('');
  const [basic, setBasic] = useState(false);
  const [retry, setRetry] = useState(0);
  const [working, setWorking] = useState<'capture' | 'compare' | null>(null);
  const { data: source } = useResource<SourceStatus>('/source-revisions/' + project.heads.current_source_revision_id);
  const verify = details.run?.applies_to_current ? details.run : null;
  const results = useResource<{ items: Result[] }>(verify?.completeness ? '/verification-runs/' + verify.id + '/results?limit=200' : null);
  useEffect(() => {
    const controller = new AbortController();
    setPreparing(true);
    setPrepareError('');
    s1<{ basic: boolean }>(path + '/test-cases/prepare', { method: 'POST', signal: controller.signal })
      .then(async result => { if (!controller.signal.aborted) { setBasic(result.basic); await refresh(); } })
      .catch(error => { if (!controller.signal.aborted) setPrepareError((error as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setPreparing(false); });
    return () => controller.abort();
  }, [path, project.heads.current_module_revision_id, refresh, retry]);
  function download() {
    void op.run('Preparing your tests…', async () => {
      const cases = await s1(path + '/test-cases');
      downloadBlob(new Blob([JSON.stringify(cases, null, 2) + '\n'], { type: 'application/json' }), 'test-cases.json');
      return 'Tests downloaded.';
    });
  }
  function capture() {
    setWorking('capture');
    void op.run('Capturing original outputs twice per case…', async signal => {
      const job = await post<{ job_id: string }>(path + '/reference-captures', {
        source_revision_id: project.heads.current_source_revision_id, environment_id: original,
        test_case_ids: details.cases.map(c => c.id), repeat: 2,
      });
      const result = await waitJob<CaptureProgress>(job.job_id, signal);
      await refresh();
      if (result.couldnt_run?.length) throw new Error('Some original results could not be recorded: ' + result.couldnt_run.map(f => (details.cases.find(c => c.id === f.test_case_id)?.name ?? 'Test') + ': ' + captureProblem(f.reason)).join('; '));
      return 'Capture finished. Review the reference statuses below.';
    }).finally(() => setWorking(null));
  }
  function compare() {
    setWorking('compare');
    void op.run('Preparing verification…', async (signal, progress) => {
      try {
        await checkReplacement({ project, cases: details.cases, original, replacement,
          runnable: source?.eligibility.execution.status === 'runnable', post, wait: waitJob,
          workspace: () => s1Local('/workspace?project=' + encodeURIComponent(project.id)), signal, progress });
        return 'Verification finished.';
      } finally { await refresh(); }
    }).finally(() => setWorking(null));
  }
  const running = ['queued', 'running'].includes(verify?.job_status ?? '');
  const busy = op.busy || preparing || running;
  const outcomeLabels: Record<string, string> = { match: 'Match', difference: 'Difference', couldnt_run: 'Couldn’t run', needs_reference: 'Not captured yet' };
  return <>
    <section className="panel s1-panel s1-fields">
      <div className="s1-row"><h2>Test cases</h2><button type="button" className="secondary" disabled={busy || !details.cases.length} onClick={download}>Download tests</button></div>
      {preparing && <p role="status"><Spinner />Loading tests…</p>}
      {prepareError && <p role="alert">{prepareError} <button type="button" className="secondary" disabled={busy} onClick={() => setRetry(n => n + 1)}>Try again</button></p>}
      {(basic || (details.cases.length === 1 && details.cases[0].name === 'No input')) && <p className="hint">Only a basic check with no input is available. Generate an updated replacement to get suggested tests for your features.</p>}
      <div className="s1-row">
        <button type="button" className="secondary" onClick={capture} disabled={busy || !details.cases.length || !original || source?.eligibility.execution.status !== 'runnable'}>Capture original results</button>
        <button type="button" className="primary" onClick={compare} disabled={busy || !details.cases.length || !replacement}>Check replacement</button>
      </div>
      {source?.eligibility.execution.status !== 'runnable' && <p className="hint">The original is not ready to run. Check its execution status on Import before comparing tests.</p>}
      {!!details.cases.length && <table className="s1-table">
        <thead><tr><th>Case</th><th>Original result</th><th>Result</th></tr></thead>
        <tbody>{details.cases.map(c => {
          const result = results.data?.items.find(r => r.test_case_id === c.id);
          return <tr key={c.id}><th scope="row">{c.name}</th><td>{c.capture_id ? c.capture_deterministic ? 'Captured twice · consistent' : 'Captured · varies' : working ? <><Spinner />Capturing…</> : 'Not captured yet'}</td>
            <td className={result?.outcome === 'match' ? 'pass' : undefined}>{result ? outcomeLabels[result.outcome] ?? result.outcome : verify?.completeness && !results.error ? <><Spinner />Loading results…</> : running || working === 'compare' ? <><Spinner />Running…</> : 'Pending'}
              {result?.differences?.map((d, i) => <span className="hint" key={i}> · {channelLabels[d.channel] ?? 'Result'} differs</span>)}
            </td></tr>;
        })}</tbody>
      </table>}
      {results.error && <p role="alert">{results.error}</p>}
      {verify?.summary && <p role="status">{verify.summary.match ?? 0} matched · {verify.summary.difference ?? 0} differences · {verify.summary.needs_reference ?? 0} need reference · {verify.summary.couldnt_run ?? 0} couldn’t run</p>}
      {verify && !verify.summary && <p role="status">{running && <Spinner />}Verification: {verify.job_status}</p>}
    </section>
    <Continue stage={4} disabled={busy} />
  </>;
}
