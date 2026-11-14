import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const CaseInput = z.object({
  argv: z.array(z.string()).max(256).default([]),
  env: z.record(z.string(), z.string()).default({}),
  stdin_blob: sha.nullable().default(null),
  files: z
    .array(z.object({ path: z.string().min(1).max(512), blob: sha, mode: z.string().regex(/^[0-7]{3,4}$/).default('0644') }))
    .max(200)
    .default([]),
  timeout_ms: z.number().int().min(1).max(60_000).default(10_000),
});
export type CaseInput = z.infer<typeof CaseInput>;

const Channel = z.object({ sha256: sha, size: z.number().int().min(0), blob: sha.optional() });

/** Observation contract shared by original, replacement and exported replay (§7.1). */
export const Observation = z.object({
  exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }),
  stdout: Channel,
  stderr: Channel,
  files: z
    .array(
      z.object({
        path: z.string(),
        status: z.enum(['created', 'modified', 'deleted']),
        sha256: sha.nullable(),
        size: z.number().int().min(0),
        blob: sha.optional(),
      }),
    )
    .default([]),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean(), files: z.boolean() }),
  resources: z.object({ wall_ms: z.number(), max_rss_kb: z.number() }).partial().optional(),
  complete: z.boolean(),
});
export type Observation = z.infer<typeof Observation>;

export const Outcome = z.enum(['match', 'difference', 'couldnt_run', 'needs_reference']);
export type Outcome = z.infer<typeof Outcome>;
