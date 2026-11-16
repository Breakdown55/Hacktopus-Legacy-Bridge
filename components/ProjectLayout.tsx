'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { projectPath, stages } from '@/lib/projects';
import { useProjects } from './ProjectProvider';
import Sidebar from './Sidebar';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { projects } = useProjects();
  const project = projects?.find(p => p.id === id);
  if (!projects) return <p className="workspace" role="status">Loading project…</p>;
  if (!project) return <section className="workspace"><h1>Project not found</h1><Link href="/">All projects</Link></section>;

  return (
    <div className="shell">
      <Sidebar currentId={id} projects={projects.map(({ id, name }) => ({ id, name }))} />
      <div className="workflow">
        <nav className="stage-nav" aria-label="Workflow steps">
          {stages.map((label, i) => {
            const path = projectPath(id, i);
            return i > project.complete
              ? <span key={label} aria-disabled="true">{label}</span>
              : <Link key={label} href={path} aria-current={pathname === path ? 'step' : undefined}>{label}</Link>;
          })}
        </nav>
        {children}
      </div>
    </div>
  );
}
