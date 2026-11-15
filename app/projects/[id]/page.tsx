'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useProjects } from '@/components/ProjectProvider';
import { projectPath, stages } from '@/lib/projects';
import { s1Enabled } from '@/lib/s1-client';
import { S1Resume } from '@/components/s1/ProjectShell';

export default function ResumeProject() {
  return s1Enabled ? <S1Resume /> : <PrototypeResume />;
}

function PrototypeResume() {
  const { id } = useParams<{ id: string }>();
  const { projects } = useProjects();
  const router = useRouter();
  const complete = projects?.find(p => p.id === id)?.complete;

  useEffect(() => {
    if (complete !== undefined) router.replace(projectPath(id, Math.min(complete, stages.length - 1)));
  }, [complete, id, router]);

  return <p className="workspace" role="status">Opening project…</p>;
}
