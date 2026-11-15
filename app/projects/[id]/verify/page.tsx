'use client';

import StagePage from '@/components/StagePage';
import S1Stage from '@/components/s1/StageFrame';
import VerifyView from '@/components/s1/Verify';
import { s1Enabled } from '@/lib/s1-client';
import VerifyStage from '@/components/stages/VerifyStage';

export default function Page() {
  return s1Enabled ? <S1Stage stage={3} View={VerifyView} /> : <StagePage stage={3} Content={VerifyStage} />;
}
