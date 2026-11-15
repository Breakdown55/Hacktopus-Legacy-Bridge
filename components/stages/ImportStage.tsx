'use client';

import Action from './Action';
import type { StageProps } from '../StagePage';
import { useRef, useState, type DragEvent } from 'react';
import { notExecutableMessage, readExecutableKind } from '@/lib/executable';
import ContextPanel from '../ContextPanel';
import Icon from '../Icon';
import AnalysisPanel from '../AnalysisPanel';

export default function ImportStage(props: StageProps) {
  const { project, onAdvance, notify } = props;
  const [file, setFile] = useState<File | null>(null);
  const [selection, setSelection] = useState(0);
  const latest = useRef(0);
  async function selectFile(file: File, input?: HTMLInputElement) {
    const request = ++latest.current;
    const kind = await readExecutableKind(file).catch(() => null);
    if (request !== latest.current) return;
    if (!kind) {
      if (input) input.value = '';
      notify(notExecutableMessage);
      return;
    }
    setFile(file);
    setSelection(value => value + 1);
    props.onSource(file.name);
  }
  const [dropOver, setDropOver] = useState(false);
  function onDrag(type: 'dragover' | 'dragleave' | 'drop', event: DragEvent<HTMLElement>) {
    if (type === 'dragover' && !event.dataTransfer.types.includes('Files')) return;
    if (type === 'drop' && !event.dataTransfer.files.length) return;
    event.preventDefault();
    if (type === 'dragleave' && event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropOver(type === 'dragover');
    if (type === 'drop') void selectFile(event.dataTransfer.files[0]);
  }

  return (
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
          <strong>Upload executable</strong>
          <span id="file-label">{project.source || 'Drag a file here or browse'}</span>
          <input
            type="file"
            id="source-file"
            aria-label="Upload legacy executable"
            onChange={e => { const file = e.target.files?.[0]; if (file) void selectFile(file, e.target); }}
          />
        </label>
        <ContextPanel
          project={project}
          version={0}
          onNotes={props.onNotes}
          onTouch={props.onTouch}
          notify={notify}
        />
      </div>
      {(!project.demo || file || project.analysisJobId) && <AnalysisPanel key={selection} project={project} file={file} onQueued={props.onAnalysisQueued} onCandidates={props.onCandidates} />}
      <Action label="Continue to Select" disabled={!project.source} onClick={onAdvance} />
    </>
  );
}
