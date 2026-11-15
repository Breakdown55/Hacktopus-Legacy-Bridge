'use client';

import Action from './Action';
import type { StageProps } from '../StagePage';

export default function VerifyStage(props: StageProps) {
  const { project, onAdvance } = props;
  const selected = project.selected;
  return (
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
}
