import type { CSSProperties } from 'react';
import Link from 'next/link';
import Icon from './Icon';
import { age, projectPath, stages } from '@/lib/projects';
import type { Project } from '@/lib/types';

function Progress({ project }: { project: Project }) {
  const complete = project.complete;
  const currentStage = stages[complete];
  return (
    <div
      className="steps"
      role="img"
      aria-label={complete + ' of 5 steps completed' + (currentStage ? ', ' + currentStage + (project.needs ? ' needs your input' : ' in progress') : '')}
      style={{ '--fill': Math.min(complete, 4) * 25 + '%' } as CSSProperties}
    >
      {stages.map((stage, i) => (
        <span key={stage} className="step" aria-hidden="true">
          {i === complete && project.needs ? (
            <span className="dot needs" title={stage + ' needs your input'}><Icon name="question" /></span>
          ) : (
            <span className={'dot ' + (i < complete ? 'done' : i === complete ? 'current' : '')} />
          )}
          <span className="step-label">{stage}</span>
        </span>
      ))}
    </div>
  );
}

type Props = {
  projects: Project[];
  onDownload: (project: Project) => void;
  onDelete: (project: Project) => void;
  onNew: () => void;
};

export default function Picker({ projects, onDownload, onDelete, onNew }: Props) {
  return (
    <section className="picker">
      <h1>Your Projects</h1>
      <div className="grid">
        {projects.map(project => (
          <article className="project" key={project.id}>
            <header className="card-tools">
              <h2><Link className="project-link" href={projectPath(project.id)}>{project.name}</Link></h2>
              <div className="controls">
                <button type="button" className="icon" title="Download" aria-label={'Download ' + project.name} onClick={() => onDownload(project)}>
                  <Icon name="download" />
                </button>
                <button type="button" className="icon delete" title="Delete" aria-label={'Delete ' + project.name} onClick={() => onDelete(project)}>
                  <Icon name="delete" />
                </button>
              </div>
            </header>
            <div className="project-main">
              <p>{project.description || 'No description'}</p>
              <Progress project={project} />
            </div>
            <footer className="project-footer">
              <p>Edited {age(project.edited)}</p>
            </footer>
          </article>
        ))}
        {projects.length === 0 ? <p className="empty">Your workspace is empty.</p> : null}
      </div>
      <button className="add" onClick={onNew}>
        <span><Icon name="plus" /></span>New project
      </button>
    </section>
  );
}
