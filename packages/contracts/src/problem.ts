import { z } from 'zod';

/** RFC 9457 problem+json (§5.1). */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  action: z.object({ kind: z.string() }).catchall(z.unknown()).optional(),
  retryable: z.boolean().default(false),
  request_id: z.string().optional(),
  fields: z.array(z.object({ path: z.string(), code: z.string() })).nullable().default(null),
});
export type Problem = z.infer<typeof Problem>;
