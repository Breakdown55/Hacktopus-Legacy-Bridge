'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { projectPath } from '@/lib/projects';
import { s1, s1Enabled } from '@/lib/s1-client';

type Item = { id: string; name: string };
type Org = { execution_enabled: boolean; external_model_allowed: boolean };

/**
 * Left sidebar: Home, a Projects list that is always open with the current project highlighted, and at the bottom the account name, Settings and Help.
 * There is no sign-in in the demo, so the name is fixed text. `load` fetches the project list on mount and whenever the current project changes.
 */
export default function Sidebar({ currentId, projects, load }: { currentId: string; projects?: Item[]; load?: () => Promise<Item[]> }) {
  const [items, setItems] = useState<Item[] | null>(projects ?? null);
  const [failed, setFailed] = useState(false);
  const settings = useRef<HTMLDialogElement>(null);
  const help = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(() => {
    if (!load) return;
    load().then(list => { setItems(list); setFailed(false); }).catch(() => setFailed(true));
  }, [load]);
  // Refreshed on every page change, so a project created or deleted elsewhere shows up without a reload.
  useEffect(() => { refresh(); }, [refresh, currentId]);
  useEffect(() => { if (projects) setItems(projects); }, [projects]);

  return <aside aria-label="Sidebar" className="sidebar">
    <nav aria-label="Main" className="side-nav">
      <Link className="side-item" href="/">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 4l8 7M6 10v10h4v-6h4v6h4V10" /></svg>Home
      </Link>
      <div className="side-item side-label">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        Projects
      </div>
      <div id="side-projects" className="side-projects">
        {!items && !failed && <p className="hint" role="status">Loading…</p>}
        {failed && !items && <p className="hint" role="alert">Couldn’t load projects.</p>}
        {items?.length === 0 && <p className="hint">No projects yet.</p>}
        {items?.map(p => <Link key={p.id} href={projectPath(p.id)} className={p.id === currentId ? 'selected' : undefined}
          aria-current={p.id === currentId ? 'page' : undefined}>{p.name}</Link>)}
      </div>
    </nav>
    <div className="side-bottom">
      <div className="side-account">
        <span className="side-avatar" aria-hidden="true">DC</span>
        <strong>Dorsey Campbell</strong>
      </div>
      <button type="button" className="side-item" onClick={() => settings.current?.showModal()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10M16 4v6M8 14v6" /></svg>Settings
      </button>
      <button type="button" className="side-item" onClick={() => help.current?.showModal()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9a3 3 0 1 1 5.12 2.12c-1.2 1.2-2.12 1.6-2.12 3.38m0 3.5h.01" /></svg>Help
      </button>
    </div>
    <SettingsDialog dialog={settings} />
    <HelpDialog dialog={help} />
  </aside>;
}

function SettingsDialog({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  const [org, setOrg] = useState<Org | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    if (!s1Enabled) { setMessage('Settings are available in the local backend workflow.'); return; }
    setMessage('');
    s1<Org>('/org').then(setOrg).catch(error => setMessage((error as Error).message));
  }
  async function change(patch: Partial<Org>) {
    setBusy(true);
    setMessage('');
    try { setOrg(await s1<Org>('/org', { method: 'PATCH', data: patch })); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  // The dialog is closed by the browser (Escape or the button), so the state is simply refreshed each time it is opened.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const observer = new MutationObserver(() => { if (element.open) load(); });
    observer.observe(element, { attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return <dialog ref={dialog} className="dialog" aria-labelledby="settings-title">
    <h2 id="settings-title">Settings</h2>
    {org && <div className="s1-fields">
      <label className="s1-checkbox"><input type="checkbox" checked={org.external_model_allowed} disabled={busy}
        onChange={e => void change({ external_model_allowed: e.target.checked })} />Send evidence to AI (function names and generated code)</label>
      <label className="s1-checkbox"><input type="checkbox" checked={org.execution_enabled} disabled={busy}
        onChange={e => void change({ execution_enabled: e.target.checked })} />Allow running programs in the sandbox</label>
      <p className="hint">These apply to the whole demo workspace.</p>
    </div>}
    {!org && !message && <p role="status">Loading…</p>}
    {message && <p role="alert">{message}</p>}
    <form method="dialog" className="actions"><button className="secondary">Close</button></form>
  </dialog>;
}

function HelpDialog({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  return <dialog ref={dialog} className="dialog" aria-labelledby="help-title">
    <h2 id="help-title">How it works</h2>
    <ol className="process">
      <li><strong>Import</strong>: upload the old program (a Linux x86-64 executable).</li>
      <li><strong>Select</strong>: pick the features the analysis found, and add any it missed.</li>
      <li><strong>Modernize</strong>: generate the replacement and answer any questions it has.</li>
      <li><strong>Verify</strong>: run the same test cases on both programs and compare.</li>
      <li><strong>Export</strong>: download the code with the test results and a replay script.</li>
    </ol>
    <p className="hint">A match only means the replacement behaved the same on the cases you ran.</p>
    <form method="dialog" className="actions"><button className="secondary">Close</button></form>
  </dialog>;
}
