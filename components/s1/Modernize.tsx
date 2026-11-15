'use client';

import { useState } from 'react';
import { post } from '@/lib/s1-client';
import { useS1Project } from './ProjectShell';
import { Continue, useResource, type Operation } from './StageFrame';
type ModuleStatus = { number: number; build: { status: string; diagnostics: { message?: string }[] } };

export default function Modernize({ op }: { op: Operation }) {
  const { project, refresh } = useS1Project();
  const [files, setFiles] = useState<File[]>([]);
  const current = project.heads.current_module_revision_id;
  const module = useResource<ModuleStatus>(current ? '/module-revisions/' + current : null, true);
  function build() {
    void op.run('Uploading and queuing the TypeScript build…', async () => {
      await post('/projects/' + project.id + '/module-revisions', {
        origin: 'customer_upload', scope_revision_id: project.heads.approved_scope_revision_id,
        files: await Promise.all(files.map(async file => ({ path: 'src/' + file.name, content: await file.text() }))),
      });
      await refresh();
      return 'Module revision saved.';
    });
  }
  return <>
    <section className="panel s1-panel s1-fields">
      <label className="field">Replacement TypeScript files<input type="file" accept=".ts" multiple disabled={op.busy} onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label>
      <p className="hint">Include index.ts with an exported run function.</p>
      <button className="primary" type="button" onClick={build} disabled={op.busy || !files.length}>Upload and build module</button>
      <p role="status">{module.error || (module.data ? 'Revision ' + module.data.number + ' · Build: ' + module.data.build.status : current ? 'Loading build status…' : '')}</p>
      {module.data?.build.diagnostics.map((d, i) => <p key={i} className="hint">{d.message}</p>)}
    </section>
    <Continue stage={3} />
  </>;
}
