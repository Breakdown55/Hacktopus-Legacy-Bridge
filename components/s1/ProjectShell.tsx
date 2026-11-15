'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { projectPath, stages } from '@/lib/projects';
import { s1, s1Local, type S1Project } from '@/lib/s1-client';

export type Verification = {
  id: string;
  job_status: string;
  completeness: string | null;
  summary: Record<string, number> | null;
  applies_to_current: boolean;
};
type Details = {
  source: { path: string; execution_consent_at: string | null } | null;
  environments: { id: string; name: string; role: string }[];
  cases: { id: string; name: string; capture_id: string | null; capture_deterministic: boolean | null }[];
  caseSet: { test_case_id: string; reference_output_id: string | null }[];
  run: Verification | null;
  export: { id: string; status: string } | null;
};
type Workspace = { project: S1Project; details: Details; refresh: () => Promise<void> };
const Context = createContext<Workspace | null>(null);

export function useS1Project() {
  const workspace = useContext(Context);
  if (!workspace) throw new Error('Missing S1 project layout');
  return workspace;
}

export function S1Resume() {
  const { project } = useS1Project();
  const router = useRouter();
  const path = projectPath(project.id, Math.min(4, project.progress.completed_steps));
  useEffect(() => { router.replace(path); }, [router, path]);
  return <p className="workspace">Opening project…</p>;
}

export default function S1ProjectShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const path = usePathname();
  const [loaded, setLoaded] = useState<Omit<Workspace, 'refresh'> | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [project, details] = await Promise.all([
      s1<S1Project>('/projects/' + encodeURIComponent(id)),
      s1Local<Details>('/workspace?project=' + encodeURIComponent(id)),
    ]);
    setLoaded({ project, details });
    setError('');
  }, [id]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await refresh(); }
      catch (error) { if (active) setError((error as Error).message); }
      if (active) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  if (!loaded || loaded.project.id !== id) {
    return <section className="workspace"><p role="status">{error || 'Loading project…'}</p><Link href="/">All projects</Link></section>;
  }
  const { project } = loaded;
  return <Context.Provider value={{ ...loaded, refresh }}>
    <div className="shell">
      <aside aria-label="Project sidebar">
        <h2>{project.name}</h2>
        <Link className="secondary nav-home" href="/">All projects</Link>
      </aside>
      <div className="workflow">
        <nav className="stage-nav" aria-label="Workflow steps">
          {stages.map((name, index) => {
            const href = projectPath(id, index);
            return index <= project.progress.completed_steps
              ? <Link key={name} href={href} aria-current={path === href ? 'step' : undefined}>{name}</Link>
              : <span key={name} aria-disabled="true">{name}</span>;
          })}
        </nav>
        {error && <p className="notice" role="alert">{error}</p>}
        {children}
      </div>
    </div>
  </Context.Provider>;
}
