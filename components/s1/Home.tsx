'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { downloadFile, projectPath } from '@/lib/projects';
import { pickerProject, post, s1, s1Blob, s1Local, type S1Project } from '@/lib/s1-client';
import type { Project } from '@/lib/types';
import Picker from '../Picker';

export default function S1Home() {
  const [projects, setProjects] = useState<S1Project[]>([]);
  const [message, setMessage] = useState('Loading projects…');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const router = useRouter();

  async function refresh() {
    const page = await s1<{ items: S1Project[] }>('/projects?limit=50');
    setProjects(page.items);
  }

  useEffect(() => {
    void refresh().then(() => setMessage('')).catch(error => setMessage(error.message));
  }, []);

  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try { await operation(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void act(async () => {
      const name = String(values.get('name')).trim();
      const description = String(values.get('description')).trim();
      if (!name) throw new Error('Enter a project name.');
      const project = await post<S1Project>('/projects', { name, description });
      dialog?.close();
      router.push(projectPath(project.id, 0));
    });
  }

  function remove(project: Project) {
    if (window.confirm('Delete ' + project.name + '?')) void act(async () => {
      await s1('/projects/' + project.id, { method: 'DELETE' });
      await refresh();
    });
  }

  function download(project: Project) {
    void act(async () => {
      const details = await s1Local<{ export: { id: string; status: string } | null }>('/workspace?project=' + project.id);
      if (details.export?.status !== 'ready') throw new Error('Build this project’s export on the Export page first.');
      downloadFile(await s1Blob('/exports/' + details.export.id), 'legacy-bridge-export.zip');
    });
  }

  return <>
    <Picker projects={projects.map(pickerProject)} onNew={() => dialog?.showModal()} onDelete={remove} onDownload={download} />
    <dialog ref={setDialog} className="dialog">
      <form onSubmit={create}>
        <h2>New project</h2>
        <label className="field">Project name<input name="name" maxLength={80} required autoFocus /></label>
        <label className="field">Description<input name="description" maxLength={140} /></label>
        <div className="actions">
          <button className="secondary" type="button" onClick={() => dialog?.close()}>Cancel</button>
          <button className="primary" disabled={busy}>Create project</button>
        </div>
      </form>
    </dialog>
    {message && <div className="toast" role="status">{message}</div>}
  </>;
}
