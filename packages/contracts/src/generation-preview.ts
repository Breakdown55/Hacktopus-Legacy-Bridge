import { z } from 'zod';

/** Suggested inputs only. Expected results must come from an independent reference. */
export const SuggestedTestCase = z.strictObject({
  name: z.string().min(1).max(200),
  argv: z.array(z.string().max(2000)).max(64),
  stdin: z.string().max(32000),
  files: z.array(z.strictObject({ path: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_./-]+$/), text: z.string().max(32000) })).max(20),
});
export const SuggestedTestCases = z.array(SuggestedTestCase).max(20);
export type SuggestedTestCase = z.infer<typeof SuggestedTestCase>;
