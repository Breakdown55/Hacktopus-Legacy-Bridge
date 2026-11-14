import { z } from 'zod';

export const AnalysisEligibility = z.enum(['unknown', 'eligible', 'partial', 'ineligible']);
export const ExecutionEligibility = z.enum(['unknown', 'runnable', 'not_runnable', 'unsupported', 'not_permitted']);
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const JobKind = z.enum(['inspect', 'index', 'deep_analysis', 'probe', 'generate', 'build', 'capture', 'verify', 'export']);
export const Role = z.enum(['admin', 'editor', 'viewer']);
export const ArtifactRole = z.enum(['primary_executable', 'shared_library', 'data_file', 'documentation', 'media', 'other']);
export type AnalysisEligibility = z.infer<typeof AnalysisEligibility>;
export type ExecutionEligibility = z.infer<typeof ExecutionEligibility>;
