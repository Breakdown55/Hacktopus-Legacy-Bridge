'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TARGET_LANGUAGES, targetOf } from '@lb/contracts';
import Picker from './Picker';
import { useProjects } from './ProjectProvider';
import { downloadPlan, projectPath } from '@/lib/projects';
import { removeProjectAttachments } from '@/lib/attachments';
import type { Project } from '@/lib/types';

type DialogState = { type: 'create' } | { type: 'delete'; id: string } | null;

export default function ProjectHome() {
  const { projects, insert, remove, notify } = useProjects();
  const router = useRouter();
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogState && !dialog.open) dialog.showModal();
    if (!dialogState && dialog.open) dialog.close();
  }, [dialogState]);

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (dialogState?.type === 'delete') {
      const id = dialogState.id;
      void removeProjectAttachments(id).catch(() => notify('Project deleted, but attachment storage could not be cleaned up.'));
      remove(id);
      setDialogState(null);
      notify('Project deleted.');
      return;
    }
    const data = new FormData(form);
    const name = String(data.get('name')).trim();
    if (!name) {
      (form.elements.namedItem('name') as HTMLInputElement).focus();
      return;
    }
    const item: Project = {
      id: globalThis.crypto?.randomUUID?.() ?? 'project-' + Date.now(),
      name,
      target_language: targetOf(String(data.get('target_language'))).id,
      description: String(data.get('description')).trim(),
      complete: 0,
      edited: Date.now(),
      features: [],
      selected: [],
    };
    insert(item);
    setDialogState(null);
    router.push(projectPath(item.id, 0));
  }

  const deleting = dialogState?.type === 'delete' ? projects?.find(p => p.id === dialogState.id) : undefined;

  if (!projects) return null;
  return (
    <>
      <Picker
        projects={projects}
        onDownload={p => { downloadPlan(p); notify('Project plan downloaded.'); }}
        onDelete={p => setDialogState({ type: 'delete', id: p.id })}
        onNew={() => setDialogState({ type: 'create' })}
      />
      <dialog className="dialog" id="dialog" ref={dialogRef} onClose={() => setDialogState(null)}>
        {dialogState?.type === 'create' ? (
          <form id="create-form" onSubmit={submitDialog}>
            <h2>New project</h2>
            <label className="field">Project name<input name="name" maxLength={80} required autoFocus /></label>
            <label className="field">Description<input name="description" maxLength={140} /></label>
            <label className="field">Target language
              <select name="target_language" defaultValue="typescript">
                {TARGET_LANGUAGES.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
            </label>
            <div className="actions">
              <button type="button" className="secondary" onClick={() => setDialogState(null)}>Cancel</button>
              <button className="primary">Create project</button>
            </div>
          </form>
        ) : null}
        {deleting ? (
          <form id="delete-form" onSubmit={submitDialog}>
            <h2>Delete project?</h2>
            <p>{deleting.name} will be removed from this browser.</p>
            <div className="actions">
              <button type="button" className="secondary" autoFocus onClick={() => setDialogState(null)}>Cancel</button>
              <button className="primary danger">Delete project</button>
            </div>
          </form>
        ) : null}
      </dialog>
    </>
  );
}
