'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, type ComponentType } from 'react';
import { downloadPlan, headings, projectPath } from '@/lib/projects';
import type { Project } from '@/lib/types';
import { useProjects } from './ProjectProvider';

export type StageProps = {
  project: Project;
  onAdvance: () => void;
  onSource: (name: string) => void;
  onAnalysisQueued: (id: string) => void;
  onCandidates: (names: string[]) => void;
  onNotes: (notes: string) => void;
  onTouch: () => void;
  onToggleFeature: (feature: string, checked: boolean) => void;
  onAddFeature: (feature: string) => boolean;
  notify: (message: string) => void;
};

export default function StagePage({ stage, Content }: { stage: number; Content: ComponentType<StageProps> }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { projects, update, notify } = useProjects();
  const project = projects?.find(p => p.id === id);
  const heading = useRef<HTMLHeadingElement>(null);
  const complete = project?.complete;

  useEffect(() => {
    if (complete !== undefined && stage > complete) router.replace(projectPath(id, complete));
    else heading.current?.focus();
  }, [complete, id, router, stage]);

  if (!project || stage > project.complete) return null;

  function advance() {
    if (stage === 4) {
      if (!project!.selected.length) { notify('Select at least one feature before exporting.'); return; }
      update(id, p => ({ ...p, complete: 5 }));
      downloadPlan(project!);
      notify('Project plan downloaded.');
      return;
    }
    update(id, p => ({ ...p, needs: stage === 3 ? false : p.needs, complete: Math.max(p.complete, stage + 1) }));
    router.push(projectPath(id, stage + 1));
  }

  function addFeature(feature: string) {
    if (!feature || project!.features.some(value => value.toLowerCase() === feature.toLowerCase())) {
      notify('Enter a new feature name.');
      return false;
    }
    update(id, p => ({ ...p, features: [...p.features, feature], selected: [...p.selected, feature] }));
    return true;
  }

  return (
    <section className="workspace">
      <h1 tabIndex={-1} ref={heading}>{headings[stage][0]}</h1>
      <p>{headings[stage][1]}</p>
      <Content
        key={id}
        project={project}
        onAdvance={advance}
        onSource={name => update(id, p => ({
          // A new executable invalidates everything derived from the old one; notes and context stay.
          ...p, source: name, analysisJobId: undefined, demo: false,
          features: [], selected: [], needs: false, complete: 0,
        }))}
        onAnalysisQueued={analysisJobId => update(id, p => ({ ...p, analysisJobId }))}
        onCandidates={names => update(id, p => ({ ...p, features: [...new Set([...p.features, ...names])] }))}
        onNotes={notes => update(id, p => ({ ...p, notes }))}
        onTouch={() => update(id, p => p)}
        onToggleFeature={(feature, checked) => update(id, p => ({
          ...p, selected: checked ? [...new Set([...p.selected, feature])] : p.selected.filter(s => s !== feature),
        }))}
        onAddFeature={addFeature}
        notify={notify}
      />
    </section>
  );
}
