import { z } from 'zod';

export const NormalizerRef = z.object({ id: z.string(), version: z.number().int().min(1), params: z.record(z.string(), z.string()).optional() });
const Mode = z.enum(['exact', 'normalized', 'tolerance', 'ignore']);

const Channel = z
  .object({ mode: Mode, normalizers: z.array(NormalizerRef).optional(), reason: z.string().optional() })
  .superRefine((v, ctx) => {
    if (v.mode === 'ignore' && !v.reason) ctx.addIssue({ code: 'custom', message: 'ignore requires a reason', path: ['reason'] });
    if (v.mode === 'normalized' && !(v.normalizers?.length)) ctx.addIssue({ code: 'custom', message: 'normalized requires normalizers', path: ['normalizers'] });
  });

export const PolicyRules = z.object({
  engine: z.string(),
  exit: z.object({ mode: z.enum(['exact', 'ignore']), reason: z.string().optional() }).default({ mode: 'exact' }),
  stdout: Channel.default({ mode: 'exact' }),
  stderr: Channel.default({ mode: 'exact' }),
  files: z.object({ include: z.array(z.string()).default([]), mode: z.enum(['exact', 'ignore']).default('exact'), reason: z.string().optional() }).default({ include: [], mode: 'exact' }),
  numeric: z.object({ applies_to: z.enum(['stdout', 'stderr']), tokenizer: z.literal('decimal-v1'), abs: z.number().min(0), rel: z.number().min(0) }).optional(),
}).superRefine((v, ctx) => {
  for (const ch of ['stdout', 'stderr'] as const) {
    if (v[ch].mode === 'tolerance' && v.numeric?.applies_to !== ch) ctx.addIssue({ code: 'custom', path: ['numeric'], message: `${ch} tolerance requires numeric.applies_to=${ch}` });
  }
});
export type PolicyRules = z.infer<typeof PolicyRules>;
