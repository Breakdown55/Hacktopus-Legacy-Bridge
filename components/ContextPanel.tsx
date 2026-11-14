'use client';

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import Icon from './Icon';
import { downloadFile } from '@/lib/projects';
import {
  addAttachments, getAttachment, listAttachments, removeAttachment, type Attachment,
} from '@/lib/attachments';
import type { Project } from '@/lib/types';

type Props = {
  project: Project;
  version: number;
  onNotes: (notes: string) => void;
  onTouch: () => void;
  notify: (message: string) => void;
};

export default function ContextPanel({ project, version, onNotes, onTouch, notify }: Props) {
  const projectId = project.id;
  const [items, setItems] = useState<Attachment[]>([]);
  const [failed, setFailed] = useState(false);
  const [over, setOver] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listAttachments(projectId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh, version]);

  async function attachMedia(files: File[]) {
    const media = files.filter(file => /^(image|video)\//.test(file.type));
    if (!files.length) return;
    if (!media.length) return notify('Choose a photo or video file.');
    try {
      await addAttachments(projectId, media);
      onTouch();
      await refresh();
      notify(media.length === files.length ? 'Attachments saved.' : 'Photos and videos saved. Other files were skipped.');
    } catch {
      notify('Could not save attachments. Check available browser storage and try again.');
    }
  }

  async function useAttachment(id: string, remove: boolean) {
    try {
      const item = await getAttachment(id);
      if (item?.projectId !== projectId) return;
      if (remove) {
        await removeAttachment(id);
        onTouch();
        await refresh();
        document.querySelector<HTMLInputElement>('#context-media')?.focus();
        notify('Attachment removed.');
      } else downloadFile(item.file, item.file.name);
    } catch {
      notify('Could not access this attachment.');
    }
  }

  function onDrag(type: 'dragover' | 'dragleave' | 'drop', event: DragEvent<HTMLElement>) {
    if (type === 'dragover' && !event.dataTransfer.types.includes('Files')) return;
    if (type === 'drop' && !event.dataTransfer.files.length) return;
    event.preventDefault();
    if (type === 'dragleave' && event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOver(type === 'dragover');
    if (type === 'drop') void attachMedia([...event.dataTransfer.files]);
  }

  return (
    <section
      className="panel context-panel"
      id="context-panel"
      aria-labelledby="context-title"
      onDragOver={e => onDrag('dragover', e)}
      onDragLeave={e => onDrag('dragleave', e)}
      onDrop={e => onDrag('drop', e)}
    >
      <h2 id="context-title">Extra context</h2>
      <label className="field">
        Notes
        <textarea
          id="context"
          placeholder="Add project notes or documentation"
          value={project.notes ?? ''}
          onChange={e => onNotes(e.target.value)}
        />
      </label>
      <label className={'drop' + (over ? ' over' : '')} id="media-drop">
        <Icon name="upload" />
        <strong>Drop photos or videos here</strong>
        <span>or browse files</span>
        <input
          type="file"
          id="context-media"
          aria-label="Attach photos or videos"
          accept="image/*,video/*"
          multiple
          onChange={e => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void attachMedia(files);
          }}
        />
      </label>
      <ul className="attachments" id="attachments" aria-label="Attached photos and videos">
        {failed ? (
          <li className="hint">Attachments are unavailable in this browser.</li>
        ) : (
          items.map(({ id, file }) => (
            <li key={id}>
              <button className="attachment-name" aria-label={'Download ' + file.name} onClick={() => void useAttachment(id, false)}>
                {file.name}
              </button>
              <button className="icon delete" aria-label={'Remove ' + file.name} onClick={() => void useAttachment(id, true)}>
                <Icon name="delete" />
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
