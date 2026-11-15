'use client';

import { useState } from 'react';
import { post, waitJob } from '@/lib/s1-client';
import { wordfreqCases } from '@/lib/s1-wordfreq';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation, type SourceStatus } from './StageFrame';
type Result = { test_case_id: string; outcome: string; differences: { channel: string; kind: string }[] };

export default function Verify({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const original = details.environments.find(e => e.role === 'original')?.id;
  const replacement = details.environments.find(e => e.role === 'replacement')?.id;
  const [input, setInput] = useState('');
  const { data: source } = useResource<SourceStatus>('/source-revisions/' + project.heads.current_source_revision_id);
  const verify = details.run?.applies_to_current ? details.run : null;
  const results = useResource<{ items: Result[] }>(verify?.completeness ? '/verification-runs/' + verify.id + '/results?limit=200' : null);
  function saveCases() {
    void op.run('Saving test cases…', async signal => {
      const parsed: unknown = JSON.parse(input);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200) throw new Error('Enter a JSON list with 1 to 200 cases.');
      for (const item of parsed) {
        signal.throwIfAborted();
        await post(path + '/test-cases', item);
      }
      await refresh();
      return 'Test cases saved.';
    });
  }
  function capture() {
    void op.run('Capturing original outputs twice per case…', async signal => {
      const job = await post<{ job_id: string }>(path + '/reference-captures', {
        source_revision_id: project.heads.current_source_revision_id, environment_id: original,
        test_case_ids: details.cases.map(c => c.id), repeat: 2,
      });
      await waitJob(job.job_id, signal);
      await refresh();
      return 'Capture finished. Review the reference statuses below.';
    });
  }
  function compare() {
    void op.run('Running verification…', async signal => {
      if (!project.heads.current_policy_id) await post(path + '/comparison-policies', {});
      const set = details.cases.map(c => ({ test_case_id: c.id, reference_output_id: c.capture_id }));
      const sameSet = set.length === details.caseSet.length && set.every((item, i) =>
        item.test_case_id === details.caseSet[i].test_case_id && item.reference_output_id === details.caseSet[i].reference_output_id,
      );
      if (!sameSet || !project.heads.current_case_set_revision_id) await post(path + '/case-set-revisions', { set });
      const run = await post<{ job_id: string }>(path + '/verification-runs', { environment_id: replacement });
      await refresh();
      await waitJob(run.job_id, signal);
      await refresh();
      return 'Verification finished.';
    });
  }
  const busy = op.busy || ['queued', 'running'].includes(verify?.job_status ?? '');
  const outcomeLabels: Record<string, string> = { match: 'Match', difference: 'Difference', couldnt_run: 'Couldn’t run', needs_reference: 'Needs reference' };
  return <>
    <section className="panel s1-panel s1-fields">
      <div className="s1-row"><h2>Test cases</h2><button type="button" className="secondary" disabled={busy} onClick={() => setInput(JSON.stringify(wordfreqCases, null, 2))}>Load wordfreq cases</button></div>
      <label className="field">Test cases (JSON)<textarea rows={7} value={input} disabled={busy} spellCheck={false} onChange={e => setInput(e.target.value)} /></label>
      <div className="s1-row">
        <button type="button" className="secondary" onClick={saveCases} disabled={busy || !input.trim()}>Save cases</button>
        <button type="button" className="secondary" onClick={capture} disabled={busy || !details.cases.length || !original || source?.eligibility.execution.status !== 'runnable'}>Capture original outputs</button>
        <button type="button" className="primary" onClick={compare} disabled={busy || !details.cases.length || !replacement}>Run verification</button>
      </div>
      {source?.eligibility.execution.status !== 'runnable' && <p className="hint">Run the original execution probe on Import to capture references.</p>}
      {!!details.cases.length && <table className="s1-table">
        <thead><tr><th>Case</th><th>Reference</th><th>Result</th></tr></thead>
        <tbody>{details.cases.map(c => {
          const result = results.data?.items.find(r => r.test_case_id === c.id);
          return <tr key={c.id}><th scope="row">{c.name}</th><td>{c.capture_id ? c.capture_deterministic ? 'Captured twice · consistent' : 'Captured · varies' : 'Needs reference'}</td>
            <td className={result?.outcome === 'match' ? 'pass' : undefined}>{result ? outcomeLabels[result.outcome] ?? result.outcome : verify?.completeness && !results.error ? 'Loading results…' : 'Pending'}
              {result?.differences?.map((d, i) => <span className="hint" key={i}> · {d.channel} {d.kind}</span>)}
            </td></tr>;
        })}</tbody>
      </table>}
      {results.error && <p role="alert">{results.error}</p>}
      {verify?.summary && <p role="status">{verify.summary.match ?? 0} matched · {verify.summary.difference ?? 0} differences · {verify.summary.needs_reference ?? 0} need reference · {verify.summary.couldnt_run ?? 0} couldn’t run</p>}
      {verify && !verify.summary && <p role="status">Verification: {verify.job_status}</p>}
    </section>
    <Continue stage={4} />
  </>;
}
