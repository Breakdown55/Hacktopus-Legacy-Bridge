export const MAX_ANALYSIS_BYTES = 16 * 1024 * 1024;

export type AnalysisResult = {
  summary: string;
  candidates: { name: string; evidence: string }[];
  limitations: string[];
};

export type AnalysisStatus = {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: AnalysisResult;
  error?: string;
};
