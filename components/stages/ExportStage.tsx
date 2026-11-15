'use client';

import Action from './Action';
import Link from 'next/link';
import { projectPath } from '@/lib/projects';
import type { StageProps } from '../StagePage';
import { targetOf } from '@lb/contracts';

export default function ExportStage(props: StageProps) {
  const { project, onAdvance } = props;
  const selected = project.selected;
  const { extension } = targetOf(project.target_language);
  return (
    <>
      <div className="panels">
        <section className="panel">
          <h2>New tools</h2>
          <ul className="files">{selected.map(s => <li key={s}>{s}.{extension}</li>)}</ul>
        </section>
        <section className="panel">
          <h2>Tests</h2>
          <ul className="files">{selected.map(s => <li key={s}>{s}.test.{extension}</li>)}</ul>
        </section>
      </div>
      {selected.length
        ? <p className="notice">The export contains project settings and the planned file list.</p>
        : <p className="notice" role="alert">No features are selected, so there is nothing to export. <Link href={projectPath(project.id, 1)}>Select features</Link></p>}
      <Action label="Download project plan" disabled={!selected.length} onClick={onAdvance} />
    </>
  );
}
