'use client';

import { useRef, useState } from 'react';
import { post, s1 } from '@/lib/s1-client';
import { approvalBlockers, emptyScope, openQuestions, prune, type Scope } from '@/lib/scope-doc';
import EvidencePanel, { type IndexedFinding } from './EvidencePanel';
import { useS1Project } from './ProjectShell';
import ScopeCitation from './ScopeCitation';
import ScopeEditor from './ScopeEditor';
import ScopeRevisions, { type RevisionSummary } from './ScopeRevisions';
import { Continue, useResource, type Operation } from './StageFrame';

type Draft = { version: number; base_revision_id: string | null; document: Scope | null };

export default function Select({ op }: { op: Operation }) {
  const { project, refresh } = useS1Project();
  const path = '/projects/' + project.id;
  const sourceId = project.heads.current_source_revision_id;
  const [reload, setReload] = useState(0);
  const draft = useResource<Draft>(path + '/scope-draft?r=' + reload);
  const revisions = useResource<{ items: RevisionSummary[] }>(path + '/scope-revisions?r=' + reload);
  // `edited` holds unsaved changes; null means the form shows the saved draft.
  const [edited, setEdited] = useState<Scope | null>(null);
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [citation, setCitation] = useState<{ sourceId: string; finding: IndexedFinding } | null>(null);
  const [citationAdded, setCitationAdded] = useState(false);
  const scopeHeading = useRef<HTMLHeadingElement>(null);

  const saved = draft.data?.document ?? emptyScope(project.name);
  const working = edited ?? saved;
  const dirty = edited !== null;
  const version = draft.data?.version ?? 0;
  const blockers = approvalBlockers(working);
  const open = openQuestions(working).length;
  const latest = revisions.data?.items[0];
  const approvedHead = revisions.data?.items.find(i => i.is_approved_head);

  function change(next: Scope) { setEdited(next); setCitationAdded(false); }
  function selectCitation(finding: IndexedFinding) {
    if (!sourceId) return;
    setCitation({ sourceId, finding });
    setCitationAdded(false);
    scopeHeading.current?.focus();
  }
  function done() { setEdited(null); setBase(undefined); setReload(n => n + 1); }

  function save() {
    void op.run('Saving the scope draft…', async () => {
      await s1(path + '/scope-draft', {
        method: 'PUT', headers: { 'if-match': '"v' + version + '"' },
        data: { document: prune(working), ...(base !== undefined ? { base_revision_id: base } : {}) },
      }).catch(error => {
        if (/precondition|412|version/i.test((error as Error).message)) throw new Error('The scope draft changed since you opened it. Discard your edits to load the latest draft.');
        throw error;
      });
      done();
      return 'Draft saved. Create a revision when it is ready for review.';
    });
  }
  function createRevision() {
    void op.run('Creating a scope revision…', async () => {
      const revision = await post<{ number: number }>(path + '/scope-revisions', { from_draft_version: version });
      setReload(n => n + 1);
      return 'Revision ' + revision.number + ' created. Review it below, then approve or reject it.';
    });
  }
  function decide(revision: RevisionSummary, decision: 'approved' | 'rejected', comment?: string) {
    void op.run(decision === 'approved' ? 'Approving scope…' : 'Rejecting scope…', async () => {
      await post('/scope-revisions/' + revision.id + '/decision', { decision, document_sha256: revision.document_sha256, ...(comment ? { comment } : {}) });
      await refresh();
      setReload(n => n + 1);
      return decision === 'approved' ? 'Revision ' + revision.number + ' approved. It is now the scope for code generation.' : 'Revision ' + revision.number + ' rejected.';
    });
  }
  function editCopy(revision: RevisionSummary, document: Scope) {
    setEdited(structuredClone(document));
    setBase(revision.id);
    setCitation(null);
    scopeHeading.current?.focus();
  }
  function applyJson() {
    try {
      const value: unknown = JSON.parse(jsonText);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The scope must be a JSON object.');
      change(value as Scope);
      setJsonError('');
    } catch (error) { setJsonError((error as Error).message); }
  }

  return <>
    {sourceId && <EvidencePanel key={sourceId} sourceId={sourceId} onCite={selectCitation} op={op} />}
    <section className="panel s1-panel s1-fields">
      <h2 tabIndex={-1} ref={scopeHeading}>Workflow scope</h2>
      <p className="hint" role="status">
        Draft version {version}{draft.data?.base_revision_id && !dirty ? ' · continues from an earlier revision' : ''}
        {dirty ? ' · unsaved changes' : ''}{base ? ' · editing a copy of a revision' : ''}
      </p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {citation && citation.sourceId === sourceId && <ScopeCitation
        key={citation.finding.id} finding={citation.finding} text={JSON.stringify(working)}
        onApply={value => { change(JSON.parse(value)); setCitation(null); setCitationAdded(true); scopeHeading.current?.focus(); }}
        onCancel={() => { setCitation(null); scopeHeading.current?.focus(); }}
      />}
      {citationAdded && <p role="status">Citation added to the draft. Save the draft to keep it.</p>}
      <ScopeEditor doc={working} onChange={change} disabled={op.busy || !draft.data} />
      <details onToggle={e => { const next = (e.currentTarget as HTMLDetailsElement).open; setShowJson(next); if (next) setJsonText(JSON.stringify(working, null, 2)); }}>
        <summary>Edit as JSON (inputs, outputs, required state and intentional changes live here)</summary>
        {showJson && <>
          <label className="field">Scope document (JSON)<textarea rows={14} spellCheck={false} value={jsonText} disabled={op.busy} onChange={e => setJsonText(e.target.value)} /></label>
          {jsonError && <p role="alert">{jsonError}</p>}
          <button type="button" className="secondary" disabled={op.busy} onClick={applyJson}>Apply JSON to the form</button>
        </>}
      </details>
      {open > 0 && <p className="hint">{open} open questions are recorded with the scope. Resolve them first if they change what gets built.</p>}
      {blockers.length > 0 && <p className="hint" role="status">Not ready to approve: {blockers.join(' ')}</p>}
      <div className="s1-row">
        <button type="button" className="primary" disabled={op.busy || !dirty || !draft.data} onClick={save}>Save draft</button>
        <button type="button" className="secondary" disabled={op.busy || !draft.data || dirty || version < 1} onClick={createRevision}>Create revision for review</button>
        {dirty && <button type="button" className="secondary" disabled={op.busy} onClick={() => { setEdited(null); setBase(undefined); setCitation(null); }}>Discard edits</button>}
      </div>
      {dirty && <p className="hint">Save the draft before creating a revision.</p>}
    </section>
    <section className="panel s1-panel s1-fields">
      <h2>Scope revisions</h2>
      {revisions.error && <p role="alert">{revisions.error}</p>}
      {latest && (approvedHead
        ? approvedHead.source_is_current
          ? <p className="hint">The approved revision is the scope that code generation will use.</p>
          : <p role="alert">The approved revision was written for an earlier executable. Review the scope against the new source, create a revision, and approve it before continuing.</p>
        : <p className="hint">No revision is approved yet.</p>)}
      <ScopeRevisions items={revisions.data?.items ?? []} busy={op.busy}
        onEdit={editCopy} onApprove={r => decide(r, 'approved')} onReject={(r, comment) => decide(r, 'rejected', comment)} />
    </section>
    <Continue stage={2} />
  </>;
}
