import type { CSSProperties } from 'react';
import Icon from './Icon';
import { age, stages } from '@/lib/projects';
import type { Project } from '@/lib/types';

function Progress({ project }: { project: Project }) {
  const complete = project.complete;
  return (
    <div
      className="steps"
      role="img"
      aria-label={complete + ' of 5 steps completed' + (complete < 5 ? ', ' + stages[complete] + ' in progress' : '')}
      style={{ '--fill': Math.min(complete, 4) * 25 + '%' } as CSSProperties}
    >
      {stages.map((_, i) => (
        <span key={i} className={'dot ' + (i < complete ? 'done' : i === complete ? 'current' : '')} />
      ))}
    </div>
  );
}

type Props = {
  projects: Project[];
  onOpen: (id: string) => void;
  onDownload: (project: Project) => void;
  onDelete: (project: Project) => void;
  onNew: () => void;
};

export default function Picker({ projects, onOpen, onDownload, onDelete, onNew }: Props) {
  return (
    <section className="picker">
      <h1>Your Projects</h1>
      <p>Open a project or start a new one.</p>
      <div className="grid">
        {projects.map(project => (
          <article className="project" key={project.id}>
            <div className="card-tools">
              {project.needs ? (
                <span className="needs" title="Needs your input" aria-label="Needs your input">?</span>
              ) : null}
              <div className="controls">
                <button className="icon" aria-label={'Download ' + project.name} onClick={() => onDownload(project)}>
                  <Icon name="download" />
                </button>
                <button className="icon delete" aria-label={'Delete ' + project.name} onClick={() => onDelete(project)}>
                  <Icon name="delete" />
                </button>
              </div>
            </div>
            <button className="project-main" onClick={() => onOpen(project.id)}>
              <h2>{project.name}</h2>
              <span className="card-rule"></span>
              <p>{project.description || 'No description'}</p>
              <Progress project={project} />
              <p className="edited">Edited {age(project.edited)}</p>
            </button>
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
