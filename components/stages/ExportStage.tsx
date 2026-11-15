'use client';

import Action from './Action';
import type { StageProps } from '../StagePage';

export default function ExportStage(props: StageProps) {
  const { project, onAdvance } = props;
  const selected = project.selected;
  return (
    <>
      <div className="panels">
        <section className="panel">
          <h2>New tools</h2>
          <ul className="files">{selected.map(s => <li key={s}>{s}.ts</li>)}</ul>
        </section>
        <section className="panel">
          <h2>Tests</h2>
          <ul className="files">{selected.map(s => <li key={s}>{s}.test.ts</li>)}</ul>
        </section>
      </div>
      <p className="notice">The export contains project settings and the planned file list.</p>
      <Action label="Download project plan" onClick={onAdvance} />
    </>
  );
}
