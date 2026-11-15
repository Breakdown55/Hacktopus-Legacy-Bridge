import type { TargetLanguage } from '@lb/contracts';

export type Project = {
  id: string;
  name: string;
  target_language?: TargetLanguage;
  description: string;
  complete: number;
  edited: number;
  needs?: boolean;
  source?: string;
  analysisJobId?: string;
  notes?: string;
  features: string[];
  selected: string[];
  demo?: boolean;
};
