import { z } from 'zod';

const Basis = z.enum(['observed', 'inferred', 'customer_requirement', 'intentional_change']);

/** Scope/interface document, schema_version 1 (§3.4). The four bases are distinct enum values and never merged. */
export const ScopeDocV1 = z.object({
  workflow: z.object({
    name: z.string().min(1),
    invocation: z.object({ argv_template: z.array(z.string()), stdin: z.enum(['none', 'text', 'bytes']).default('none') }),
  }),
  inputs: z.array(z.object({ id: z.string(), kind: z.enum(['argv', 'stdin', 'file', 'env']) }).catchall(z.unknown())).default([]),
  outputs: z.array(z.object({ id: z.string(), kind: z.enum(['stdout', 'stderr', 'exit_status', 'file']) }).catchall(z.unknown())).default([]),
  required_state: z.array(z.object({ id: z.string(), kind: z.literal('file'), path: z.string(), mode: z.enum(['read', 'write', 'readwrite']) })).default([]),
  dependencies: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['time', 'random', 'env', 'filesystem', 'network']),
        disposition: z.enum(['explicit_input', 'preserved', 'removed']),
        responsibility_change: z.string().optional(),
        evidence: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  interface: z.object({ language: z.literal('typescript'), export: z.string().default('run') }).catchall(z.unknown()),
  behaviors: z.array(z.object({ id: z.string(), statement: z.string(), basis: Basis, evidence: z.array(z.string()).default([]), notes: z.string().default('') })).default([]),
  intentional_changes: z.array(z.object({ id: z.string(), behavior: z.string(), description: z.string(), approved_reason: z.string() })).default([]),
  decisions: z.array(z.object({ id: z.string(), text: z.string(), by: z.string().optional(), at: z.string().optional() })).default([]),
  assumptions: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  open_questions: z.array(z.object({ id: z.string(), text: z.string(), status: z.enum(['open', 'resolved']), resolution: z.string().nullable().default(null) })).default([]),
});
export type ScopeDocV1 = z.infer<typeof ScopeDocV1>;
