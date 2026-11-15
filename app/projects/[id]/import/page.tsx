'use client';

import StagePage from '@/components/StagePage';
import S1Stage from '@/components/s1/StageFrame';
import ImportView from '@/components/s1/Import';
import { s1Enabled } from '@/lib/s1-client';
import ImportStage from '@/components/stages/ImportStage';

export default function Page() {
  return s1Enabled ? <S1Stage stage={0} View={ImportView} /> : <StagePage stage={0} Content={ImportStage} />;
}
