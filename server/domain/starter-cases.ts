import type { CaseInput } from '@lb/contracts';
import { SuggestedTestCases } from '../../packages/contracts/src/generation-preview';
import { wordfreqCases } from '../../lib/s1-wordfreq';
import { createTestCase, type CaseSpec } from './cases';
import type { Ctx } from './ctx';
import { getHeads } from './projects';
import { DomainError } from './errors';

/** Serialize first-visit preparation so remounts and concurrent tabs cannot duplicate cases. Never creates references. */
export async function prepareTestCases(c: Ctx, projectId: string) {
  await getHeads(c.db, c.orgId, projectId);
  return c.db.tx(async db => {
    await db.query('SELECT id FROM projects WHERE id=$1 AND org_id=$2 FOR UPDATE', [projectId, c.orgId]);
    const heads = await getHeads(db, c.orgId, projectId);
    const existing = await db.query('SELECT id FROM test_cases WHERE project_id=$1 AND org_id=$2', [projectId, c.orgId]);
    if (!heads.current_module_revision_id) throw new DomainError('module_required', 409, 'Create your replacement first.');
    const [mod] = await db.query<{ generator: { test_cases?: unknown } | null; scope_revision_id: string }>(
      'SELECT generator,scope_revision_id FROM module_revisions WHERE id=$1 AND org_id=$2', [heads.current_module_revision_id, c.orgId]);
    if (mod.scope_revision_id !== heads.approved_scope_revision_id) throw new DomainError('scope_changed', 409, 'Update your replacement for the selected features first.');
    const suggested = SuggestedTestCases.parse(mod.generator?.test_cases ?? []);
    let cases: { name: string; input: CaseSpec }[] = suggested.map(t => ({ name: t.name, input: { argv: t.argv, stdin: { text: t.stdin }, files: t.files } }));
    let basic = false;
    if (!cases.length && existing.length) return { count: existing.length, basic };
    if (!cases.length) {
      const [source] = await db.query<{ path: string }>("SELECT path FROM source_artifacts WHERE source_revision_id=$1 AND org_id=$2 AND role='primary_executable'", [heads.current_source_revision_id, c.orgId]);
      if (/(^|\/)wordfreq(?:\.stripped)?$/.test(source?.path ?? '')) cases = wordfreqCases;
      else { cases = [{ name: 'No input', input: {} }]; basic = true; }
    }
    for (const item of cases) await createTestCase({ ...c, db }, projectId, item.name, item.input, 'template');
    const all = await db.query('SELECT id FROM test_cases WHERE project_id=$1 AND org_id=$2', [projectId, c.orgId]);
    return { count: all.length, basic };
  });
}

/** Portable inputs, including file bytes, rather than storage-only blob identifiers. */
export async function downloadTestCases(c: Ctx, projectId: string) {
  await getHeads(c.db, c.orgId, projectId);
  const cases = await c.db.query<{ name: string; input: CaseInput }>('SELECT name,input FROM test_cases WHERE project_id=$1 AND org_id=$2 ORDER BY created_at,id', [projectId, c.orgId]);
  return Promise.all(cases.map(async ({ name, input }) => ({ name, input: {
    argv: input.argv, env: input.env, timeout_ms: input.timeout_ms,
    stdin: { base64: input.stdin_blob ? (await c.store.get(c.orgId, input.stdin_blob)).toString('base64') : '' },
    files: await Promise.all(input.files.map(async f => ({ path: f.path, mode: f.mode, base64: (await c.store.get(c.orgId, f.blob)).toString('base64') }))),
  } })));
}
