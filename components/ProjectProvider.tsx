'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { loadProjects, storageKey } from '@/lib/projects';
import { s1Enabled } from '@/lib/s1-client';
import type { Project } from '@/lib/types';

type ProjectState = {
  projects: Project[] | null;
  insert: (project: Project) => void;
  remove: (id: string) => void;
  update: (id: string, patch: (project: Project) => Project) => void;
  notify: (text: string) => void;
};

const ProjectContext = createContext<ProjectState | null>(null);
const configuredProfile = process.env.NEXT_PUBLIC_LB_MACHINE_PROFILE;
const machineProfile = configuredProfile === 'PROD' || configuredProfile === 'TEST'
  ? configuredProfile : s1Enabled ? 'TEST' : null;

export function useProjects() {
  const state = useContext(ProjectContext);
  if (!state) throw new Error('Missing ProjectProvider');
  return state;
}

export default function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const current = useRef<Project[]>([]);
  const [message, setMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    current.current = loadProjects();
    setProjects(current.current);
    return () => clearTimeout(toastTimer.current);
  }, []);

  function notify(text: string) {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(''), 3500);
  }

  function commit(next: Project[]) {
    current.current = next;
    setProjects(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      notify('Could not save projects in this browser.');
    }
  }

  const state: ProjectState = {
    projects,
    insert: project => commit([...current.current, project]),
    remove: id => commit(current.current.filter(p => p.id !== id)),
    update: (id, patch) => commit(current.current.map(p => p.id === id
      ? { ...patch(p), edited: Date.now() } : p)),
    notify,
  };
  return (
    <ProjectContext.Provider value={state}>
      <header className="top">
        <Link className="brand" id="home" aria-label="Legacy Bridge projects" href="/">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 14h20M6 5v14M18 5v14M6 8c5 5 7 5 12 0" /></svg>
          Legacy Bridge
        </Link>
        {machineProfile && <span className="machine-badge" data-profile={machineProfile}>{machineProfile}</span>}
      </header>
      <main id="app">{children}</main>
      <div className="toast" id="toast" role="status" hidden={!message}>{message}</div>
    </ProjectContext.Provider>
  );
}
