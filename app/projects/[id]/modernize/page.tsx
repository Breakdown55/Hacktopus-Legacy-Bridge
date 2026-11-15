'use client';

import StagePage from '@/components/StagePage';
import S1Stage from '@/components/s1/StageFrame';
import ModernizeView from '@/components/s1/Modernize';
import { s1Enabled } from '@/lib/s1-client';
import ModernizeStage from '@/components/stages/ModernizeStage';

export default function Page() {
  return s1Enabled ? <S1Stage stage={2} View={ModernizeView} /> : <StagePage stage={2} Content={ModernizeStage} />;
}
