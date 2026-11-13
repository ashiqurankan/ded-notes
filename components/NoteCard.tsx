'use client';

import { memo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, Folder, Pin, RotateCcw, Trash2 } from 'lucide-react';
import type { Note } from '@/lib/types';
import { relativeDate, snippet } from '@/lib/format';

export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let index = 0;
  for (let hit = lower.indexOf(q); hit >= 0 && parts.length < 40; hit = lower.indexOf(q, index)) {
    if (hit > index) parts.push(text.slice(index, hit));
    parts.push(<mark key={hit}>{text.slice(hit, hit + q.length)}</mark>);
    index = hit + q.length;
  }
  parts.push(text.slice(index));
  return <>{parts}</>;
}

type Props = {
  note: Note;
  title: string;
  preview: string;
  active: boolean;
  checked: boolean;
  selecting: boolean;
  folderName: string | null;
  query: string;
  now: number;
  draggable: boolean;
  inTrash: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string, range: boolean) => void;
  onMenu: (id: string, point: { x: number; y: number }) => void;
  onSwipe: (id: string, direction: 'left' | 'right') => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
};

/**
 * Note list row. Desktop: click, ⌘/Ctrl/Shift-click to multi-select, right-click menu,
 * drag pinned notes to reorder. Touch: tap, long-press menu, swipe left (trash) /
 * right (archive).
 */
export const NoteCard = memo(function NoteCard(props: Props) {
  const { note, title, preview, active, checked, selecting, folderName, query, now, draggable, inTrash } = props;
  const [dx, setDx] = useState(0);
  const gesture = useRef<{ x: number; y: number; type: string; horizontal: boolean | null } | null>(null);
  const longPress = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const clearLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    suppressClick.current = false;
    gesture.current = { x: event.clientX, y: event.clientY, type: event.pointerType, horizontal: null };
    const point = { x: event.clientX, y: event.clientY };
    clearLongPress();
    longPress.current = window.setTimeout(() => {
      suppressClick.current = true;
      gesture.current = null;
      navigator.vibrate?.(8);
      props.onMenu(note.id, point);
    }, 480);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const ddx = event.clientX - g.x;
    const ddy = event.clientY - g.y;
    if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) clearLongPress();
    if (g.horizontal === null && (Math.abs(ddx) > 10 || Math.abs(ddy) > 10)) {
      g.horizontal = Math.abs(ddx) > Math.abs(ddy) * 1.4 && !selecting;
      if (g.horizontal) (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    if (g.horizontal) setDx(Math.max(-130, Math.min(130, ddx)));
  };

  const endGesture = (cancelled: boolean) => {
    clearLongPress();
    const g = gesture.current;
    gesture.current = null;
    if (g?.horizontal) {
      suppressClick.current = true;
      if (!cancelled && dx <= -85) props.onSwipe(note.id, 'left');
      else if (!cancelled && dx >= 85) props.onSwipe(note.id, 'right');
    }
    setDx(0);
  };

  const date = inTrash && note.deletedAt ? note.deletedAt : note.updatedAt;

  return (
    <div className={`note-card-wrap ${dx ? 'swiping' : ''}`}>
      {dx !== 0 && (
        <div className={`swipe-reveal ${dx > 0 ? 'right' : 'left'} ${Math.abs(dx) >= 85 ? 'armed' : ''}`} aria-hidden="true">
          {dx > 0
            ? (inTrash ? <><RotateCcw size={16}/> Restore</> : note.archived ? <><ArchiveRestore size={16}/> Unarchive</> : <><Archive size={16}/> Archive</>)
            : <><Trash2 size={16}/> {inTrash ? 'Delete' : 'Trash'}</>}
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selecting ? checked : undefined}
        aria-current={active ? 'true' : undefined}
        className={`note-card ${active && !selecting ? 'selected' : ''} ${checked ? 'checked' : ''}`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        draggable={draggable}
        onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; props.onDragStart(note.id); }}
        onDragOver={event => { if (draggable) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); props.onDrop(note.id); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endGesture(false)}
        onPointerCancel={() => endGesture(true)}
        onContextMenu={event => {
          event.preventDefault();
          if (gesture.current || suppressClick.current) return; // touch long-press handles it
          props.onMenu(note.id, { x: event.clientX, y: event.clientY });
        }}
        onClick={event => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (selecting || event.shiftKey || event.metaKey || event.ctrlKey) props.onToggle(note.id, event.shiftKey);
          else props.onOpen(note.id);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (selecting) props.onToggle(note.id, false); else props.onOpen(note.id);
          }
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const r = event.currentTarget.getBoundingClientRect();
            props.onMenu(note.id, { x: r.left + 24, y: r.top + 24 });
          }
        }}
      >
        {selecting && (
          <span className={`note-check ${checked ? 'on' : ''}`} aria-hidden="true">{checked && <Check size={12}/>}</span>
        )}
        <div className="note-card-body">
          <div className="note-card-top">
            <span className="note-card-title"><Highlight text={title} query={query}/></span>
            {note.pinned && !note.deleted && <Pin size={13} className="pin-indicator" aria-label="Pinned"/>}
          </div>
          <p className="note-preview">
            {preview ? <Highlight text={snippet(preview, query)} query={query}/> : <span className="faint">No additional text</span>}
          </p>
          <div className="note-card-meta">
            <span>{inTrash ? `Deleted ${relativeDate(date, now).toLowerCase()}` : relativeDate(date, now)}</span>
            {folderName && <span className="note-folder-chip"><Folder size={11}/>{folderName}</span>}
            {note.tags.slice(0, 3).map(tag => <span key={tag} className="note-tag-chip">#{tag}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
});
