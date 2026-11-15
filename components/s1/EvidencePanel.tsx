'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { downloadFile } from '@/lib/projects';
import { post, s1ApiBlob, waitJob } from '@/lib/s1-client';
import { useResource, type Operation } from './StageFrame';

const labels = {
  function: 'Functions',
  string: 'Strings',
  xref: 'Cross-references',
  import: 'Imports',
  pseudocode: 'Pseudocode',
};
type Kind = keyof typeof labels;

type Provenance = {
  run_id: string;
  provider: string;
  provider_version: Record<string, string>;
  artifact_path: string;
  artifact_sha256: string;
  location: Record<string, unknown> | null;
  provider_evidence_id: string;
  raw_url: string | null;
};
export type IndexedFinding = {
  id: string;
  kind: Kind;
  name: string | null;
  address: string | null;
  authority: string | null;
  attributes: Record<string, unknown>;
  provenance: Provenance;
};
type FindingDetails = IndexedFinding & { content: string | null };
type FindingPage = {
  items: IndexedFinding[];
  next_cursor: string | null;
  coverage: unknown;
  run_id: string | null;
};
type AnalysisRun = {
  id: string;
  kind: 'index' | 'deep_function';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  outcome: 'complete' | 'partial' | 'unsupported' | 'failed' | null;
  params: { address?: string };
  coverage: unknown;
  limitations: unknown;
  unknowns?: unknown;
  error?: { code?: string } | null;
  provider_version: Record<string, string> | null;
};
type Candidate = { title: string; findings: string[]; signals: string[] };
type Citation = (finding: IndexedFinding) => void;

function findingName(finding: IndexedFinding) {
  return finding.name || finding.address || labels[finding.kind] || finding.id;
}

function addressOf(address: string | undefined | null) {
  const value = address?.toLowerCase().replace(/^ram:/, '').replace(/^0x0+(?=[a-f\d])/, '0x');
  return value && /^0x[a-f\d]+$/.test(value) ? value : null;
}

function active(run: AnalysisRun | undefined) {
  return run?.status === 'queued' || run?.status === 'running';
}

function readable(run: AnalysisRun | undefined): run is AnalysisRun {
  return run?.status === 'succeeded' && (run.outcome === 'complete' || run.outcome === 'partial');
}

function runLabel(run: AnalysisRun | undefined) {
  if (!run) return 'No run yet';
  if (active(run)) return run.status === 'queued' ? 'Queued' : 'Running';
  if (run.outcome === 'unsupported') return 'Unsupported';
  if (run.outcome === 'partial') return 'Partial coverage';
  if (run.outcome === 'complete') return 'Complete';
  return run.status === 'cancelled' ? 'Cancelled' : 'Failed';
}

function limitations(input: unknown): string[] {
  return Array.isArray(input) ? input.map(value => typeof value === 'string' ? value : JSON.stringify(value)) : [];
}

function RunNotes({ run }: { run: AnalysisRun }) {
  const notes = limitations(run.limitations);
  const unknowns = limitations(run.unknowns);
  const coverage = run.coverage;
  return <>
    {run.error?.code && <p className="hint">Job error: {run.error.code.replaceAll('_', ' ')}</p>}
    {!!notes.length && <details open={run.outcome === 'unsupported' || run.outcome === 'failed' ? true : undefined}>
      <summary>Limitations ({notes.length})</summary>
      <ul className="s2-notes">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </details>}
    {!!unknowns.length && <details>
      <summary>Unknowns</summary><ul className="s2-notes">{unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </details>}
    {coverage !== null && coverage !== undefined && <details>
      <summary>Coverage details</summary><pre className="s2-pre">{JSON.stringify(coverage, null, 2)}</pre>
    </details>}
  </>;
}

function ProvenanceDetails({ finding, onCite }: { finding: FindingDetails; onCite: Citation }) {
  const [download, setDownload] = useState<'busy' | 'done' | string>();
  const origin = finding.provenance;
  const raw = origin.raw_url?.match(/^\/api\/v1(\/[^?#]+)$/)?.[1];
  async function saveRaw() {
    if (!raw) return;
    setDownload('busy');
    try {
      downloadFile(await s1ApiBlob(raw), origin.provider_evidence_id + '.json');
      setDownload('done');
    } catch (error) {
      setDownload((error as Error).message);
    }
  }

  return <>
    <dl className="s2-provenance">
      <dt>Finding ID</dt><dd><code>{finding.id}</code></dd>
      <dt>Analysis run</dt><dd><code>{origin.run_id}</code></dd>
      <dt>Provider</dt><dd>{origin.provider}</dd>
      <dt>Artifact</dt><dd>{origin.artifact_path}</dd>
      <dt>Artifact SHA-256</dt><dd><code>{origin.artifact_sha256}</code></dd>
      <dt>Provider evidence ID</dt><dd><code>{origin.provider_evidence_id}</code></dd>
      {finding.address && <><dt>Address</dt><dd><code>{finding.address}</code></dd></>}
      {finding.authority && <><dt>Authority</dt><dd>{finding.authority.replaceAll('_', ' ')}</dd></>}
    </dl>
    {!!Object.keys(finding.attributes ?? {}).length && <details>
      <summary>Finding attributes</summary><pre className="s2-pre">{JSON.stringify(finding.attributes, null, 2)}</pre>
    </details>}
    {origin.location && <details>
      <summary>Source location</summary><pre className="s2-pre">{JSON.stringify(origin.location, null, 2)}</pre>
    </details>}
    <div className="s1-row">
      <button type="button" className="secondary" onClick={() => onCite(finding)}>Cite in scope</button>
      {raw && <button type="button" className="secondary" disabled={download === 'busy'} onClick={() => void saveRaw()}>
        {download === 'busy' ? 'Downloading…' : 'Download raw evidence'}
      </button>}
    </div>
    {download && download !== 'busy' && <p role={download === 'done' ? 'status' : 'alert'}>
      {download === 'done' ? 'Evidence downloaded.' : download}
    </p>}
  </>;
}

function IncomingReferences({ sourcePath, runId, onCite }: { sourcePath: string; runId: string; onCite: Citation }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const filters = new URLSearchParams({ run_id: runId, kind: 'xref', limit: '20' });
  if (cursor) filters.set('cursor', cursor);
  const refs = useResource<FindingPage>(sourcePath + '/findings?' + filters);
  const detail = useResource<FindingDetails>(selected ? '/findings/' + encodeURIComponent(selected) : null);
  return <details>
    <summary>Incoming cross-references</summary>
    <div className="s1-fields s2-incoming">
      {refs.error && <p role="alert">{refs.error}</p>}
      {!refs.data && !refs.error && <p role="status">Loading cross-references…</p>}
      {refs.data?.items.length === 0 && <p className="hint">This run returned no incoming cross-references.</p>}
      {!!refs.data?.items.length && <ul className="s2-list">{refs.data.items.map(finding => <li key={finding.id}>
        <button type="button" className="s2-result" aria-pressed={selected === finding.id} onClick={() => setSelected(finding.id)}>
          {findingName(finding)} {finding.name && finding.address && <code>{finding.address}</code>}
        </button>
      </li>)}</ul>}
      {(cursor || refs.data?.next_cursor) && <div className="s1-row">
        <button className="secondary" type="button" disabled={!cursor} onClick={() => { setCursor(null); setSelected(null); }}>First references</button>
        <button className="secondary" type="button" disabled={!refs.data?.next_cursor} onClick={() => {
          setCursor(refs.data?.next_cursor ?? null);
          setSelected(null);
        }}>More references</button>
      </div>}
      {detail.error && <p role="alert">{detail.error}</p>}
      {selected && !detail.data && !detail.error && <p role="status">Loading reference details…</p>}
      {detail.data && <ProvenanceDetails key={detail.data.id} finding={detail.data} onCite={onCite} />}
    </div>
  </details>;
}

function Pseudocode({ sourcePath, address, run, op, onCite }: {
  sourcePath: string; address: string; run: AnalysisRun | undefined; op: Operation; onCite: Citation;
}) {
  const canRead = readable(run);
  const pseudocode = useResource<FindingPage>(canRead ? sourcePath + '/findings?kind=pseudocode&run_id=' + encodeURIComponent(run.id) : null);
  const id = pseudocode.data?.items[0]?.id;
  const detail = useResource<FindingDetails>(id ? '/findings/' + encodeURIComponent(id) : null);
  const error = pseudocode.error || detail.error;
  const loading = canRead && !error && (!pseudocode.data || (id && !detail.data));

  function requestPseudocode() {
    void op.run('Analyzing function at ' + address + '…', async signal => {
      const job = await post<{ job_id: string }>(sourcePath + '/analysis-runs', { kind: 'deep_function', params: { address } });
      await waitJob(job.job_id, signal);
      return 'Function analysis finished.';
    });
  }

  return <section className="s1-fields s2-section" aria-label="Pseudocode">
    <h3>Pseudocode</h3>
    {run && <p role="status">Function analysis: {runLabel(run)}</p>}
    {run && <RunNotes run={run} />}
    {error && <p role="alert">{error}</p>}
    {detail.data?.content && <>
      <pre tabIndex={0} className="s2-pre s2-code">{detail.data.content}</pre>
      <ProvenanceDetails finding={detail.data} onCite={onCite} />
    </>}
    {canRead && pseudocode.data && !id && <p className="hint">This run returned no pseudocode for the selected function.</p>}
    {loading && <p role="status">Loading pseudocode…</p>}
    {canRead && <IncomingReferences key={run.id} runId={run.id} sourcePath={sourcePath} onCite={onCite} />}
    {!detail.data?.content && !loading && !active(run) && <button type="button" className="secondary" disabled={op.busy} onClick={requestPseudocode}>
      {run ? 'Request pseudocode again' : 'Request pseudocode'}
    </button>}
  </section>;
}

function FindingDetail({ id, sourcePath, runs, onCite, op, onClose }: {
  id: string; sourcePath: string; runs: AnalysisRun[]; onCite: Citation; op: Operation; onClose: () => void;
}) {
  const detail = useResource<FindingDetails>('/findings/' + encodeURIComponent(id));
  const finding = detail.data;
  const address = addressOf(finding?.address);
  const deepRun = runs.find(run => run.kind === 'deep_function' && addressOf(run.params?.address) === address);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="s1-fields s2-section" aria-label="Selected finding">
    <div className="s1-row">
      <h3 ref={heading} tabIndex={-1}>{finding ? findingName(finding) : 'Finding details'}</h3>
      <button type="button" className="secondary" onClick={onClose}>Close details</button>
    </div>
    {detail.error && <p role="alert">{detail.error}</p>}
    {!detail.error && !finding && <p role="status">Loading finding…</p>}
    {finding && <>
      <ProvenanceDetails key={finding.id} finding={finding} onCite={onCite} />
      {finding.content && <pre tabIndex={0} className="s2-pre s2-code">{finding.content}</pre>}
      {finding.kind === 'function' && address && <Pseudocode key={address} sourcePath={sourcePath} address={address} run={deepRun} op={op} onCite={onCite} />}
    </>}
  </section>;
}

function Findings({ sourcePath, index, runs, onCite, op }: {
  sourcePath: string; index: AnalysisRun; runs: AnalysisRun[]; onCite: Citation; op: Operation;
}) {
  const [kind, setKind] = useState<Kind>('function');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const params = new URLSearchParams({ run_id: index.id, kind, limit: '20' });
  if (search) params.set('q', search);
  const cursor = cursors[cursors.length - 1];
  if (cursor) params.set('cursor', cursor);
  const page = useResource<FindingPage>(sourcePath + '/findings?' + params);
  const candidates = useResource<{ items: Candidate[]; run_id: string | null }>(sourcePath + '/candidates');
  const scopedCandidates = candidates.data?.run_id === index.id ? candidates.data.items : [];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(query.trim());
    setCursors([null]);
    setSelected(null);
  }

  return <>
    {!!scopedCandidates.length && <section className="s1-fields s2-section">
      <h3>Candidate workflows</h3>
      <ul className="s2-list">{scopedCandidates.map(candidate => <li key={candidate.findings[0] ?? candidate.title}>
        <strong>{candidate.title}</strong>
        {!!candidate.signals.length && <p className="hint">{candidate.signals.map(signal => signal.replaceAll('_', ' ')).join(' · ')}</p>}
        <div className="s1-row">
          {candidate.findings.map((id, i) => <button key={id} type="button" className="secondary" onClick={event => {
            detailTrigger.current = event.currentTarget;
            setSelected(id);
          }}>
            View evidence {candidate.findings.length > 1 ? i + 1 : ''}
          </button>)}
        </div>
      </li>)}</ul>
    </section>}
    {candidates.error && <p role="alert">{candidates.error}</p>}
    <form className="s1-row s2-filters" onSubmit={submitSearch}>
      <label className="field">Finding type
        <select value={kind} onChange={event => {
          setKind(event.target.value as Kind);
          setCursors([null]);
          setSelected(null);
        }}>
          {Object.entries(labels).filter(([value]) => value !== 'pseudocode').map(([value, label]) =>
            <option key={value} value={value}>{label}</option>
          )}
        </select>
      </label>
      <label className="field s2-search">Search findings
        <input type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <button type="submit" className="secondary">Search</button>
    </form>
    {page.error && <p role="alert">{page.error}</p>}
    {!page.error && !page.data && <p role="status">Loading findings…</p>}
    {page.data?.items.length === 0 && <p>No findings in this category match the current filters.</p>}
    {!!page.data?.items.length && <table className="s1-table">
      <thead><tr><th scope="col">Finding</th><th scope="col">Address</th><th scope="col">Authority</th></tr></thead>
      <tbody>{page.data.items.map(finding => <tr key={finding.id}>
        <th scope="row">
          <button type="button" className="s2-result" aria-pressed={selected === finding.id} onClick={event => {
            detailTrigger.current = event.currentTarget;
            setSelected(finding.id);
          }}>
            {findingName(finding)}
          </button>
        </th>
        <td><code>{finding.address ?? '—'}</code></td>
        <td>{finding.authority?.replaceAll('_', ' ') ?? '—'}</td>
      </tr>)}</tbody>
    </table>}
    {(cursors.length > 1 || page.data?.next_cursor) && <div className="s1-row" aria-label="Finding pages">
      <button className="secondary" type="button" disabled={cursors.length < 2} onClick={() => {
        setCursors(current => current.slice(0, -1));
        setSelected(null);
      }}>Previous page</button>
      <span>Page {cursors.length}</span>
      <button className="secondary" type="button" disabled={!page.data?.next_cursor} onClick={() => {
        if (!page.data?.next_cursor) return;
        const next = page.data.next_cursor;
        setCursors(current => [...current, next]);
        setSelected(null);
      }}>Next page</button>
    </div>}
    {selected && <FindingDetail key={selected} id={selected} sourcePath={sourcePath} runs={runs} onCite={onCite} op={op} onClose={() => {
      setSelected(null);
      detailTrigger.current?.focus();
    }} />}
  </>;
}

export default function EvidencePanel({ sourceId, onCite, op }: {
  sourceId: string; onCite: Citation; op: Operation;
}) {
  const sourcePath = '/source-revisions/' + encodeURIComponent(sourceId);
  const resource = useResource<{ runs: AnalysisRun[] }>(sourcePath + '/analysis-runs', true);
  const runs = resource.data?.runs ?? [];
  const index = runs.find(run => run.kind === 'index');
  const browsableIndex = runs.find(run => run.kind === 'index' && readable(run));

  function indexArtifact() {
    void op.run('Indexing executable evidence…', async signal => {
      const job = await post<{ job_id: string }>(sourcePath + '/analysis-runs', { kind: 'index' });
      await waitJob(job.job_id, signal);
      return 'Evidence indexing finished.';
    });
  }

  return <section className="panel s1-panel s1-fields" aria-label="Executable evidence">
    <h2>Executable evidence</h2>
    {resource.error && <p role="alert">{resource.error}</p>}
    <p role="status">Index: {resource.data ? runLabel(index) : 'Checking status…'}</p>
    {index?.provider_version && <p className="hint">
      {Object.entries(index.provider_version).map(([tool, version]) => tool + ' ' + version).join(' · ')}
    </p>}
    {index && <RunNotes run={index} />}
    {resource.data && !active(index) && index?.outcome !== 'complete' && index?.outcome !== 'unsupported' && <button
      type="button" className="secondary" disabled={op.busy} onClick={indexArtifact}>
      {index ? 'Retry evidence index' : 'Build evidence index'}
    </button>}
    {browsableIndex && browsableIndex !== index && <p className="hint">Showing findings from the previous usable index.</p>}
    {browsableIndex && <Findings key={browsableIndex.id} sourcePath={sourcePath} index={browsableIndex} runs={runs} onCite={onCite} op={op} />}
  </section>;
}
