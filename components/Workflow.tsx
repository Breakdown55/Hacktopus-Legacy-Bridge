'use client';

import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import ContextPanel from './ContextPanel';
import Icon from './Icon';
import { headings, stages } from '@/lib/projects';
import type { Project } from '@/lib/types';

type Props = {
  projects: Project[];
  project: Project;
  stage: number;
  attachmentsVersion: number;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onOpen: (id: string) => void;
  onHome: () => void;
  onStage: (stage: number) => void;
  onAdvance: () => void;
  onSource: (name: string) => void;
  onNotes: (notes: string) => void;
  onTouch: () => void;
  onToggleFeature: (feature: string, checked: boolean) => void;
  onAddFeature: (feature: string) => boolean;
  notify: (message: string) => void;
};

function Action({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="actions">
      <button className="primary" id="advance" disabled={disabled} onClick={onClick}>{label}</button>
    </div>
  );
}

export default function Workflow(props: Props) {
  const { projects, project, stage, headingRef, onAdvance, notify } = props;
  const selected = project.selected;
  const [dropOver, setDropOver] = useState(false);
  const featureInput = useRef<HTMLInputElement>(null);

  function onDrag(type: 'dragover' | 'dragleave' | 'drop', event: DragEvent<HTMLElement>) {
    if (type === 'dragover' && !event.dataTransfer.types.includes('Files')) return;
    if (type === 'drop' && !event.dataTransfer.files.length) return;
    event.preventDefault();
    if (type === 'dragleave' && event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropOver(type === 'dragover');
    if (type === 'drop') props.onSource(event.dataTransfer.files[0].name);
  }

  function submitFeature(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = featureInput.current!;
    if (props.onAddFeature(input.value.trim())) {
      event.currentTarget.reset();
      input.focus();
    }
  }

  let body;
  if (stage === 0) {
    body = (
      <>
        <div className="panels">
          <label
            className={'panel drop' + (dropOver ? ' over' : '')}
            id="drop"
            onDragOver={e => onDrag('dragover', e)}
            onDragLeave={e => onDrag('dragleave', e)}
            onDrop={e => onDrag('drop', e)}
          >
            <Icon name="upload" />
            <strong>Upload code</strong>
            <span id="file-label">{project.source || 'Drag a file here or browse'}</span>
            <input
              type="file"
              id="source-file"
              aria-label="Upload source code"
              onChange={e => { const file = e.target.files?.[0]; if (file) props.onSource(file.name); }}
            />
          </label>
          <ContextPanel
            project={project}
            version={props.attachmentsVersion}
            onNotes={props.onNotes}
            onTouch={props.onTouch}
            notify={notify}
          />
        </div>
        <Action label="Start" disabled={!project.source} onClick={onAdvance} />
      </>
    );
  } else if (stage === 1) {
    body = (
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
        <Action label="Next" disabled={!selected.length} onClick={onAdvance} />
      </>
    );
  } else if (stage === 2) {
    body = (
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
  } else if (stage === 3) {
    body = (
      <>
        <section className="panel table">
          <table>
            <thead>
              <tr><th scope="col">Tool</th><th scope="col">Test</th></tr>
            </thead>
            <tbody>
              {[...selected, 'Package'].map((s, i) => (
                <tr key={i}>
                  <td>{s}</td>
                  <td className={project.demo ? 'pass' : ''}>{project.demo ? 'Sample pass' : 'Pending'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {!project.demo ? <p className="notice">Automated verification requires a backend.</p> : null}
        <Action label="Review export" onClick={onAdvance} />
      </>
    );
  } else {
    body = (
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

  return (
    <div className="shell">
      <aside aria-label="Project sidebar">
        <h2>Projects</h2>
        <nav aria-label="Projects" className="project-nav">
          {projects.map(p => (
            <button
              key={p.id}
              className={p.id === project.id ? 'selected' : undefined}
              aria-current={p.id === project.id ? 'page' : undefined}
              onClick={() => props.onOpen(p.id)}
            >
              {p.name}
            </button>
          ))}
        </nav>
        <button className="secondary nav-home" id="all-projects" onClick={props.onHome}>All projects</button>
      </aside>
      <div className="workflow">
        <nav className="stage-nav" aria-label="Workflow steps">
          {stages.map((label, i) => (
            <button
              key={label}
              aria-current={i === stage ? 'step' : undefined}
              disabled={i > project.complete}
              onClick={() => props.onStage(i)}
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="workspace">
          <h1 tabIndex={-1} ref={headingRef}>{headings[stage][0]}</h1>
          <p>{headings[stage][1]}</p>
          {body}
        </section>
      </div>
    </div>
  );
}
