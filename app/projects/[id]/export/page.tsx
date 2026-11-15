'use client';

import StagePage from '@/components/StagePage';
import S1Stage from '@/components/s1/StageFrame';
import ExportView from '@/components/s1/Export';
import { s1Enabled } from '@/lib/s1-client';
import ExportStage from '@/components/stages/ExportStage';

export default function Page() {
  return s1Enabled ? <S1Stage stage={4} View={ExportView} /> : <StagePage stage={4} Content={ExportStage} />;
}
