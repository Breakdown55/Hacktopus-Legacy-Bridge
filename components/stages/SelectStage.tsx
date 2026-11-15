'use client';

import Action from './Action';
import AnalysisPanel from '../AnalysisPanel';
import type { StageProps } from '../StagePage';
import { useRef, type FormEvent } from 'react';

export default function SelectStage(props: StageProps) {
  const { project, onAdvance } = props;
  const selected = project.selected;
  const featureInput = useRef<HTMLInputElement>(null);
  function submitFeature(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = featureInput.current!;
    if (props.onAddFeature(input.value.trim())) {
      event.currentTarget.reset();
      input.focus();
    }
  }

  return (
    <>
      <div className="panels">
        <section className="panel">
          <h2>{project.demo ? 'Detected features' : 'Features'}</h2>
          <div className="checks">
            {project.features.length ? (
              project.features.map(feature => (
                <label key={feature}>
                  <input
                    type="checkbox"
                    checked={selected.includes(feature)}
                    onChange={e => props.onToggleFeature(feature, e.target.checked)}
                  />
                  {feature}
                </label>
              ))
            ) : (
              <p className="hint">Add a feature to get started.</p>
            )}
          </div>
        </section>
        <section className="panel">
          <h2>Did we miss something?</h2>
          <form id="feature-form" className="field" onSubmit={submitFeature}>
            <label htmlFor="feature">Feature name</label>
            <input id="feature" name="feature" maxLength={70} required placeholder="Describe a feature to look for" ref={featureInput} />
            <button className="secondary" type="submit">Add feature</button>
          </form>
        </section>
      </div>
      {project.analysisJobId && <AnalysisPanel project={project} onCandidates={props.onCandidates} />}
      <Action label="Next" disabled={!selected.length} onClick={onAdvance} />
    </>
  );
}
