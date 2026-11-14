import { createHash } from 'node:crypto';

/** Canonical JSON: sorted keys, no whitespace, so digests are stable across processes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
