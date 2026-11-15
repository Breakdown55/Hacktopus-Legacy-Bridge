'use client';

import StagePage from '@/components/StagePage';
import S1Stage from '@/components/s1/StageFrame';
import SelectView from '@/components/s1/Select';
import { s1Enabled } from '@/lib/s1-client';
import SelectStage from '@/components/stages/SelectStage';

export default function Page() {
  return s1Enabled ? <S1Stage stage={1} View={SelectView} /> : <StagePage stage={1} Content={SelectStage} />;
}
