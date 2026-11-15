'use client';

import { useState } from 'react';
import { useResource } from './StageFrame';
import type { Scope } from '@/lib/scope-doc';

export type RevisionSummary = {
  id: string; number: number; parent_id: string | null; source_revision_id: string; document_sha256: string; created_at: string;
  status: 'pending' | 'approved' | 'rejected'; is_approved_head: boolean; source_is_current: boolean;
  counts: { behaviors: number; assumptions: number; decisions: number; open_questions: number };
};
type Detail = RevisionSummary & {
  document: Scope; decision: { decision: string; decided_by: string | null; decided_at: string; comment: string | null } | null;
  evidence: { id: string; kind: string; name: string | null; address: string | null; artifact_path: string }[];
};

const statusLabel = { pending: 'Awaiting decision', approved: 'Approved', rejected: 'Rejected' } as const;

export default function ScopeRevisions({ items, busy, onEdit, onApprove, onReject }: {
  items: RevisionSummary[]; busy: boolean;
  onEdit: (revision: RevisionSummary, document: Scope) => void;
  onApprove: (revision: RevisionSummary) => void;
  onReject: (revision: RevisionSummary, comment: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const detail = useResource<Detail>(open ? '/scope-revisions/' + open : null);
  if (!items.length) return <p className="hint">No revisions yet. Save the draft, then create a revision to review and approve it.</p>;
  return <ol className="s3-revisions" reversed>
    {items.map(r => {
      const d = open === r.id ? detail.data : null;
      const blockers = [
        !r.source_is_current && 'Written for an earlier source revision.',
        r.counts.behaviors === 0 && 'Has no behaviors.',
      ].filter(Boolean);
      return <li key={r.id}>
        <div className="s1-row">
          <strong>Revision {r.number}</strong>
          <span>{statusLabel[r.status]}{r.is_approved_head ? (r.source_is_current ? ' · current approved scope' : ' · approved for an earlier executable') : ''}</span>
          <span className="hint">{r.counts.behaviors} behaviors · {r.counts.open_questions} open questions{r.parent_id ? '' : ' · first revision'}</span>
          <button type="button" className="secondary" aria-expanded={open === r.id} onClick={() => { setOpen(open === r.id ? null : r.id); setComment(''); }}>{open === r.id ? 'Hide' : 'Review'}</button>
        </div>
        {open === r.id && <div className="s1-fields s3-review">
          {detail.error && <p role="alert">{detail.error}</p>}
          {!d && !detail.error && <p role="status">Loading revision…</p>}
          {d && <>
            {d.decision && <p>{statusLabel[d.status]} on {new Date(d.decision.decided_at).toLocaleString()}{d.decision.comment ? ': ' + d.decision.comment : ''}</p>}
            <p className="hint">SHA-256 {r.document_sha256.slice(0, 16)}… · {d.evidence.length} cited findings</p>
            {d.evidence.length > 0 && <ul className="s2-notes">{d.evidence.map(f => <li key={f.id}>{f.kind} {f.name || f.address || f.id.slice(0, 8)} <span className="hint">in {f.artifact_path}</span></li>)}</ul>}
            {r.counts.open_questions > 0 && <p role="note">{r.counts.open_questions} open questions will be recorded with this decision.</p>}
            <details><summary>Scope document</summary><pre className="s2-pre s2-code">{JSON.stringify(d.document, null, 2)}</pre></details>
            <div className="s1-row">
              <button type="button" className="secondary" disabled={busy} onClick={() => onEdit(r, d.document)}>Edit a copy as the draft</button>
              {r.status === 'pending' && <>
                <button type="button" className="primary" disabled={busy || blockers.length > 0} onClick={() => onApprove(r)}>Approve revision {r.number}</button>
              </>}
            </div>
            {r.status === 'pending' && blockers.length > 0 && <p className="hint" role="status">Cannot approve: {blockers.join(' ')}</p>}
            {r.status === 'pending' && <div className="s1-row">
              <label className="field">Reason for rejecting<input value={comment} maxLength={2000} onChange={e => setComment(e.target.value)} /></label>
              <button type="button" className="secondary" disabled={busy || !comment.trim()} onClick={() => onReject(r, comment.trim())}>Reject revision {r.number}</button>
            </div>}
          </>}
        </div>}
      </li>;
    })}
  </ol>;
}
