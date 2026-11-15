import type { ReactNode } from 'react';
import ProjectLayout from '@/components/ProjectLayout';
import S1ProjectShell from '@/components/s1/ProjectShell';
import { s1Enabled } from '@/lib/s1-client';

export default function Layout({ children }: { children: ReactNode }) {
  return s1Enabled ? <S1ProjectShell>{children}</S1ProjectShell> : <ProjectLayout>{children}</ProjectLayout>;
}
