import type { Ctx } from './ctx';
import { getModuleFiles } from './modules';
import { getHeads } from './projects';
import { DomainError } from './errors';
import { unpackTar } from '../tar';
import { zip } from '../../workers/export/zip';
import { TSCONFIG } from '../../workers/build/templates';
import { moduleLanguage } from '@lb/contracts';
import { moduleFunctions } from '../../lib/module-preview';

export async function modulePackage(c: Ctx, moduleId: string, preview: boolean) {
  const [mod] = await c.db.query<{ project_id: string; target: string; number: number; created_at: string }>('SELECT project_id,target,number,created_at FROM module_revisions WHERE id=$1 AND org_id=$2', [moduleId, c.orgId]);
  if (!mod) throw new DomainError('not_found', 404);
  await getHeads(c.db, c.orgId, mod.project_id);
  const source = await getModuleFiles(c, moduleId);
  if (preview) return Response.json({ functions: moduleFunctions(source) });
  const files = new Map<string, Buffer>(source.map(f => [f.path, Buffer.from(f.content)]));
  const [build] = await c.db.query<{ output_blob_sha256: string }>("SELECT output_blob_sha256 FROM build_results WHERE module_revision_id=$1 AND org_id=$2 AND status='succeeded' ORDER BY attempt DESC LIMIT 1", [moduleId, c.orgId]);
  if (build) for (const file of unpackTar(await c.store.get(c.orgId, build.output_blob_sha256))) files.set(file.path, file.content);
  if (moduleLanguage(mod.target) === 'typescript') files.set('tsconfig.json', Buffer.from(TSCONFIG));
  files.set('README.md', Buffer.from(`# Replacement · version ${mod.number}\n\n${build ? 'Includes source and built output.' : 'Source only: a successful build is not available yet.'}\n\nThis download does not establish that the replacement matches the original. Use Verify to compare behavior and Export for the full package with replayable tests.\n`));
  return new Response(new Uint8Array(zip([...files].map(([path, content]) => ({ path, content })), new Date(mod.created_at))), {
    headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="replacement-v${mod.number}.zip"`, 'cache-control': 'no-store' },
  });
}
