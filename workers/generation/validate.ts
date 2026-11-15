import { DomainError } from '../../server/domain/errors';
import { validateModuleFiles } from '../../server/domain/modules';
import type { GenerationResult, Untranslated } from './provider';

export class GenerationOutputInvalid extends Error { constructor(public detail: string) { super('generation_output_invalid'); } }

/**
 * Validates model output before anything is stored: allow-listed paths (src/** and test/** .ts), no traversal, no non-`node:` imports,
 * size and count limits, the required entry file, and a well-formed untranslated list. The model never writes package.json, tsconfig or the CLI shim.
 */
export function validateGenerated(r: GenerationResult, behaviorIds: Set<string>): Untranslated[] {
  try {
    if (!Array.isArray(r.files) || r.files.some((f) => typeof f?.path !== 'string' || typeof f?.content !== 'string')) throw new GenerationOutputInvalid('files must be {path, content} strings');
    for (const f of r.files) if (f.path.includes('\\') || /[\0]/.test(f.content)) throw new GenerationOutputInvalid(`unsafe file: ${f.path.slice(0, 80)}`);
    validateModuleFiles(r.files);
  } catch (e) {
    if (e instanceof GenerationOutputInvalid) throw e;
    if (e instanceof DomainError) throw new GenerationOutputInvalid(`${e.code}: ${e.message}`.slice(0, 300));
    throw e;
  }
  const list = r.untranslated ?? [];
  if (!Array.isArray(list)) throw new GenerationOutputInvalid('untranslated must be an array');
  const seen = new Set<string>();
  for (const u of list) {
    if (typeof u?.id !== 'string' || !/^[\w.-]{1,64}$/.test(u.id) || seen.has(u.id)) throw new GenerationOutputInvalid('untranslated ids must be unique short identifiers');
    seen.add(u.id);
    if (typeof u.reason !== 'string' || !u.reason.trim()) throw new GenerationOutputInvalid(`untranslated ${u.id} needs a reason`);
    if (u.behaviorId !== undefined && !behaviorIds.has(u.behaviorId)) throw new GenerationOutputInvalid(`untranslated ${u.id} names an unknown behavior`);
  }
  return list.map((u) => ({ id: u.id, behaviorId: u.behaviorId, file: String(u.file ?? ''), line: Number(u.line) || 0, reason: u.reason.slice(0, 1000), evidence: (u.evidence ?? []).filter((x) => typeof x === 'string').slice(0, 20) }));
}
