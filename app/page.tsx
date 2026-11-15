import ProjectHome from '@/components/ProjectHome';
import S1Home from '@/components/s1/Home';
import { s1Enabled } from '@/lib/s1-client';

export default function Page() {
  return s1Enabled ? <S1Home /> : <ProjectHome />;
}
