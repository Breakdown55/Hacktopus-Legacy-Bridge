'use client';

import { targetOf } from '@lb/contracts';
import { downloadFile } from '@/lib/projects';
import { post, s1Blob, waitJob } from '@/lib/s1-client';
import { useS1Project } from './ProjectShell';
import type { Operation } from './StageFrame';

export default function Export({ op }: { op: Operation }) {
  const { project, details, refresh } = useS1Project();
  const run = details.run?.applies_to_current ? details.run : null;
  const pkg = details.export;
  function build() {
    if (!run) return;
    void op.run('Building replayable ZIP…', async signal => {
      const job = await post<{ job_id: string }>('/projects/' + project.id + '/exports', { verification_run_id: run.id });
      await refresh();
      await waitJob(job.job_id, signal);
      await refresh();
      return 'Package is ready.';
    });
  }
  function download() {
    if (!pkg) return;
    void op.run('Downloading…', async () => {
      downloadFile(await s1Blob('/exports/' + pkg.id), 'legacy-bridge-export.zip');
      return 'ZIP downloaded.';
    });
  }
  return <section className="panel s1-panel s1-fields">
    <h2>Replayable package</h2>
    <p>{targetOf(project.target_language).name} source, build output, recorded references, test inputs, and the replay harness.</p>
    {pkg && <p role="status">Package: {pkg.status}</p>}
    <div className="s1-row">
      <button type="button" className="secondary" onClick={build} disabled={op.busy || run?.completeness !== 'complete' || pkg?.status === 'building'}>Build export</button>
      <button type="button" className="primary" onClick={download} disabled={op.busy || pkg?.status !== 'ready'}>Download ZIP</button>
    </div>
  </section>;
}
