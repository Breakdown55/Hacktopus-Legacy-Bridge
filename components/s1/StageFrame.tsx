'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { projectPath, stages } from '@/lib/projects';
import { s1 } from '@/lib/s1-client';
import { useS1Project } from './ProjectShell';

export type SourceStatus = { eligibility: { analysis: { status: string }; execution: { status: string; reasons: string[] } }; inspection: { format: string; arch: string; needed: string[] } | null };
export type Operation = ReturnType<typeof useOperation>;

function useOperation() {
  const pending = useRef<AbortController | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);
  /** `progress` replaces the status line while the action runs. An aborted action (the page was left) reports nothing. */
  async function run(label: string, action: (signal: AbortSignal, progress: (text: string) => void) => Promise<string>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailed(false);
    setMessage(label);
    try {
      const result = await action(controller.signal, text => { if (!controller.signal.aborted) setMessage(text); });
      if (!controller.signal.aborted) setMessage(result);
    } catch (error) {
      if (!controller.signal.aborted) { setFailed(true); setMessage((error as Error).message); }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { run, busy, message, failed };
}

export function useResource<T>(path: string | null, changing = false) {
  const [entry, setEntry] = useState<{ path: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function fetchResource() {
      try {
        const data = await s1<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) { setEntry({ path: path!, data }); setFailure(null); }
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ path: path!, message: (error as Error).message });
      }
      if (changing && !controller.signal.aborted) timer = setTimeout(fetchResource, 1500);
    }
    void fetchResource();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, changing]);
  return { data: entry?.path === path ? entry?.data ?? null : null, error: failure?.path === path ? failure?.message : null };
}

export function Continue({ stage, children }: { stage: number; children?: ReactNode }) {
  const { project } = useS1Project();
  if (project.progress.completed_steps < stage) return null;
  return <div className="actions"><Link className="primary s1-link" href={projectPath(project.id, stage)}>{children ?? 'Continue to ' + stages[stage]}</Link></div>;
}


export default function S1Stage({ stage, View }: { stage: number; View: ComponentType<{ op: Operation }> }) {
  const { project } = useS1Project();
  const op = useOperation();
  if (stage > project.progress.completed_steps) return <section className="workspace">
    <h1>{stages[stage]}</h1><p>Complete {stages[project.progress.completed_steps]} to continue.</p>
    <Link className="s1-link" href={projectPath(project.id, project.progress.completed_steps)}>Go to {stages[project.progress.completed_steps]}</Link>
  </section>;
  return <section className="workspace">
    <h1>{stages[stage]}</h1>
    <View op={op} />
    {op.message && <p className="notice" role={op.failed ? 'alert' : 'status'}>{op.message}</p>}
  </section>;
}
