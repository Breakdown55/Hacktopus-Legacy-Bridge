export type Project = {
  id: string;
  name: string;
  description: string;
  complete: number;
  edited: number;
  needs?: boolean;
  source?: string;
  notes?: string;
  features: string[];
  selected: string[];
  demo?: boolean;
};
