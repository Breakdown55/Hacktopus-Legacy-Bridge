export interface NormalizerSpec {
  id: string;
  version: number;
  params?: Record<string, string>;
}
type Fn = (b: Buffer, params: Record<string, string>) => Buffer;

// Latin-1 round trips every byte, so text rules never corrupt binary data.
const text = (fn: (s: string, p: Record<string, string>) => string): Fn => (b, p) => Buffer.from(fn(b.toString('latin1'), p), 'latin1');

/** Registered as `id@version`. A version bump must never change the behavior of an existing version. */
const registry: Record<string, Fn> = {
  'line-endings@1': text((s) => s.replace(/\r\n?/g, '\n')),
  'trailing-whitespace@1': text((s) => s.replace(/[ \t]+$/gm, '')),
  'regex-replace@1': text((s, p) => {
    if (typeof p.pattern !== 'string') throw new Error('regex-replace@1 requires params.pattern');
    return s.replace(new RegExp(p.pattern, 'g'), p.replacement ?? '');
  }),
};

export const normalizerKey = (n: { id: string; version: number }) => `${n.id}@${n.version}`;
export const hasNormalizer = (n: { id: string; version: number }) => normalizerKey(n) in registry;

export function applyNormalizer(n: NormalizerSpec, data: Buffer): Buffer {
  const fn = registry[normalizerKey(n)];
  if (!fn) throw new Error(`unknown normalizer ${normalizerKey(n)}`);
  return fn(data, n.params ?? {});
}
