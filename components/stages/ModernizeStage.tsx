'use client';

import Action from './Action';
import type { StageProps } from '../StagePage';

export default function ModernizeStage(props: StageProps) {
  const { project, onAdvance } = props;
  const selected = project.selected;
  return (
    <>
      <div className="panels">
        <section className="panel">
          <h2>Packaging plan</h2>
          <ol className="process">
            <li>Analyze structure</li>
            <li>Isolate selected features</li>
            <li>Prepare TypeScript modules</li>
          </ol>
        </section>
        <section className="panel">
          <h2>Selected features</h2>
          <ul className="files">{selected.map(s => <li key={s}>{s}</li>)}</ul>
        </section>
      </div>
      <Action label="Confirm plan" onClick={onAdvance} />
    </>
  );
}
