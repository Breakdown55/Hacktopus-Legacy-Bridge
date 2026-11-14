'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Icon from './Icon';
import Picker from './Picker';
import Workflow from './Workflow';
import { downloadPlan, loadProjects, storageKey } from '@/lib/projects';
import { removeProjectAttachments } from '@/lib/attachments';
import type { Project } from '@/lib/types';

type DialogState = { type: 'create' } | { type: 'delete'; id: string } | null;

export default function App() {
  // null until mounted: projects live in localStorage, so the server render has none
  const [projects, setProjects] = useState<Project[] | null>(null);
  const projectsRef = useRef<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [message, setMessage] = useState('');
  const [attachmentsVersion, setAttachmentsVersion] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function notify(text: string) {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(''), 3500);
  }

  // Replace the project list, optionally bumping one project's edited time, and persist it.
  function commit(next: Project[], touchedId?: string) {
    if (touchedId) next = next.map(p => (p.id === touchedId ? { ...p, edited: Date.now() } : p));
    projectsRef.current = next;
    setProjects(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      notify('Could not save projects in this browser.');
    }
  }

  function update(id: string, patch: (p: Project) => Project, touch = true) {
    commit(projectsRef.current.map(p => (p.id === id ? patch(p) : p)), touch ? id : undefined);
  }

  useEffect(() => {
    commit(loadProjects());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogState && !dialog.open) dialog.showModal();
    if (!dialogState && dialog.open) dialog.close();
  }, [dialogState]);

  useEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      headingRef.current?.focus();
    }
  });

  const project = projects?.find(p => p.id === activeId);

  function openProject(id: string) {
    const target = projectsRef.current.find(p => p.id === id)!;
    setActiveId(id);
    setStage(Math.min(target.complete, 4));
    window.scrollTo(0, 0);
  }

  function home() {
    setActiveId(null);
    window.scrollTo(0, 0);
  }

  function advance() {
    if (!project) return;
    if (stage === 4) {
      update(project.id, p => ({ ...p, complete: 5 }));
      downloadPlan(project);
      notify('Project plan downloaded.');
      return;
    }
    const next = stage + 1;
    update(project.id, p => ({
      ...p,
      needs: stage === 3 ? false : p.needs,
      complete: Math.max(p.complete, next),
    }));
    setStage(next);
    focusHeading.current = true;
  }

  function addFeature(feature: string): boolean {
    if (!project) return false;
    if (!feature || project.features.some(value => value.toLowerCase() === feature.toLowerCase())) {
      notify('Enter a new feature name.');
      return false;
    }
    update(project.id, p => ({ ...p, features: [...p.features, feature], selected: [...p.selected, feature] }));
    return true;
  }

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (dialogState?.type === 'delete') {
      const id = dialogState.id;
      void removeProjectAttachments(id).catch(() => notify('Project deleted, but attachment storage could not be cleaned up.'));
      commit(projectsRef.current.filter(p => p.id !== id));
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
      description: String(data.get('description')).trim(),
      complete: 0,
      edited: Date.now(),
      features: [],
      selected: [],
    };
    commit([...projectsRef.current, item]);
    setDialogState(null);
    openProject(item.id);
  }

  const deleting = dialogState?.type === 'delete' ? projects?.find(p => p.id === dialogState.id) : undefined;

  return (
    <>
      <header className="top">
        <button className="brand" id="home" aria-label="Legacy Bridge projects" onClick={home}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 14h20M6 5v14M18 5v14M6 8c5 5 7 5 12 0" />
          </svg>
          Legacy Bridge
        </button>
      </header>
      <main id="app">
        {projects && !project ? (
          <Picker
            projects={projects}
            onOpen={openProject}
            onDownload={p => { downloadPlan(p); notify('Project plan downloaded.'); }}
            onDelete={p => setDialogState({ type: 'delete', id: p.id })}
            onNew={() => setDialogState({ type: 'create' })}
          />
        ) : null}
        {projects && project ? (
          <Workflow
            projects={projects}
            project={project}
            stage={stage}
            attachmentsVersion={attachmentsVersion}
            headingRef={headingRef}
            onOpen={openProject}
            onHome={home}
            onStage={s => { setStage(s); focusHeading.current = true; }}
            onAdvance={advance}
            onSource={name => { update(project.id, p => ({ ...p, source: name })); setAttachmentsVersion(v => v + 1); }}
            onNotes={notes => update(project.id, p => ({ ...p, notes }))}
            onTouch={() => update(project.id, p => p)}
            onToggleFeature={(feature, checked) =>
              update(project.id, p => ({
                ...p,
                selected: checked ? [...p.selected, feature] : p.selected.filter(s => s !== feature),
              }))
            }
            onAddFeature={addFeature}
            notify={notify}
          />
        ) : null}
      </main>
      <dialog className="dialog" id="dialog" ref={dialogRef} onClose={() => setDialogState(null)}>
        {dialogState?.type === 'create' ? (
          <form id="create-form" onSubmit={submitDialog}>
            <h2>New project</h2>
            <label className="field">Project name<input name="name" maxLength={80} required autoFocus /></label>
            <label className="field">Description<input name="description" maxLength={140} /></label>
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
      <div className="toast" id="toast" role="status" hidden={!message}>{message}</div>
    </>
  );
}
