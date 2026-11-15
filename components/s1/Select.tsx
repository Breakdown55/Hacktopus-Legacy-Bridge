'use client';

import { useRef, useState } from 'react';
import { post, s1 } from '@/lib/s1-client';
import EvidencePanel, { type IndexedFinding } from './EvidencePanel';
import { useS1Project } from './ProjectShell';
import ScopeCitation from './ScopeCitation';
import { Continue, useResource, type Operation } from './StageFrame';

export default function Select({ op }: { op: Operation }) {
  const { project, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const draft = useResource<{ version: number; document: unknown }>(path + '/scope-draft');
  const [input, setInput] = useState<string>();
  const sourceId = project.heads.current_source_revision_id;
  const [citation, setCitation] = useState<{ sourceId: string; finding: IndexedFinding } | null>(null);
  const [citationAdded, setCitationAdded] = useState(false);
  const scopeHeading = useRef<HTMLHeadingElement>(null);
  const text = input ?? JSON.stringify(draft.data?.document ?? {
    workflow: { name: project.name, invocation: { argv_template: [], stdin: 'text' } },
    interface: { language: 'typescript', export: 'run' },
  }, null, 2);
  function selectCitation(finding: IndexedFinding) {
    if (!sourceId) return;
    setCitation({ sourceId, finding });
    setCitationAdded(false);
    scopeHeading.current?.focus();
  }
  function approve() {
    void op.run('Saving and approving scope…', async () => {
      const document = JSON.parse(text);
      const latest = await s1<{ version: number }>(path + '/scope-draft');
      if (draft.data && latest.version !== draft.data.version) {
        throw new Error('The scope draft changed. Reload this page before approving again.');
      }
      const saved = await s1<{ version: number }>(path + '/scope-draft', {
        method: 'PUT', data: { document }, headers: { 'if-match': '"v' + latest.version + '"' },
      });
      const revision = await post<{ id: string; document_sha256: string }>(path + '/scope-revisions', { from_draft_version: saved.version });
      await post('/scope-revisions/' + revision.id + '/decision', { decision: 'approved', document_sha256: revision.document_sha256 });
      await refresh();
      return 'Scope approved.';
    });
  }
  return <>
    {sourceId && <EvidencePanel key={sourceId} sourceId={sourceId} onCite={selectCitation} op={op} />}
    <section className="panel s1-panel s1-fields">
      <h2 tabIndex={-1} ref={scopeHeading}>Workflow scope</h2>
      {draft.data && citation && citation.sourceId === sourceId && <ScopeCitation
        key={citation.finding.id} finding={citation.finding} text={text}
        onApply={value => { setInput(value); setCitation(null); setCitationAdded(true); scopeHeading.current?.focus(); }}
        onCancel={() => { setCitation(null); scopeHeading.current?.focus(); }}
      />}
      {citationAdded && <p role="status">Citation added to the draft. Approve scope to save it.</p>}
      <label className="field">Scope document (JSON)<textarea rows={12} spellCheck={false} value={text} disabled={op.busy || !draft.data} onChange={e => { setInput(e.target.value); setCitationAdded(false); }} /></label>
      {draft.error && <p role="alert">{draft.error}</p>}
      <button type="button" className="primary" disabled={op.busy || !draft.data} onClick={() => { setCitationAdded(false); approve(); }}>Approve scope</button>
    </section>
    <Continue stage={2} />
  </>;
}
