'use client';

import { memo, useEffect, useRef, useState } from 'react';
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
 * right (archive). A short swipe reveals the action button (tap it to confirm); a long
 * swipe past ~60% of the row, or a quick flick, performs the action straight away.
 */
const ACTION_W = 88;      // width of the revealed action button when a card is half-swiped
const OPEN_AT = 44;       // release past this → card stays open showing the button
const FLING_V = 0.9;      // px/ms — a quick flick commits immediately
type Side = 'left' | 'right';

export const NoteCard = memo(function NoteCard(props: Props) {
  const { note, title, preview, active, checked, selecting, folderName, query, now, draggable, inTrash } = props;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Side | null>(null);
  const [revealSide, setRevealSide] = useState<Side | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number; y: number; base: number; horizontal: boolean | null;
    dx: number; lastX: number; lastT: number; v: number; armed: boolean;
  } | null>(null);
  const longPress = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const committing = useRef(false);

  const width = () => wrapRef.current?.clientWidth || 320;
  const fullAt = () => Math.max(150, width() * 0.6);

  const clearLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  };

  const close = () => { setOpen(null); setDx(0); };

  const commit = (side: Side) => {
    if (committing.current) return;
    committing.current = true;
    setOpen(null);
    setRevealSide(side);
    setDx(side === 'left' ? -width() : width());
    navigator.vibrate?.(10);
    window.setTimeout(() => {
      committing.current = false;
      props.onSwipe(note.id, side);
      setDx(0);
    }, 200);
  };

  // An open card closes when you touch anything else, scroll, or press Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => { if (selecting) close(); }, [selecting]);

  // Fallback in case transitionend never fires (reduced motion, hidden tab).
  useEffect(() => {
    if (dx !== 0 || dragging || open || !revealSide) return;
    const t = window.setTimeout(() => setRevealSide(null), 300);
    return () => window.clearTimeout(t);
  }, [dx, dragging, open, revealSide]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' || committing.current) return;
    suppressClick.current = false;
    const base = open === 'left' ? -ACTION_W : open === 'right' ? ACTION_W : 0;
    gesture.current = {
      x: event.clientX, y: event.clientY, base, horizontal: null,
      dx: base, lastX: event.clientX, lastT: event.timeStamp, v: 0, armed: false,
    };
    clearLongPress();
    if (open) return; // touching an open card just closes it (or drags it)
    const point = { x: event.clientX, y: event.clientY };
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
      if (g.horizontal) {
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        setDragging(true);
      }
    }
    if (!g.horizontal) return;
    const dt = event.timeStamp - g.lastT;
    if (dt > 0) g.v = 0.6 * ((event.clientX - g.lastX) / dt) + 0.4 * g.v;
    g.lastX = event.clientX;
    g.lastT = event.timeStamp;
    const w = width();
    g.dx = Math.max(-w, Math.min(w, g.base + ddx));
    const armed = Math.abs(g.dx) >= fullAt();
    if (armed && !g.armed) navigator.vibrate?.(6);
    g.armed = armed;
    if (g.dx !== 0) setRevealSide(g.dx < 0 ? 'left' : 'right');
    setDx(g.dx);
  };

  const endGesture = (event: React.PointerEvent, cancelled: boolean) => {
    clearLongPress();
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!g) return;
    if (!g.horizontal) {
      // Plain tap on an open card closes it instead of opening the note.
      if (open && !cancelled) { suppressClick.current = true; close(); }
      return;
    }
    suppressClick.current = true;
    if (cancelled || g.dx === 0) { close(); return; }
    const side: Side = g.dx < 0 ? 'left' : 'right';
    const v = event.timeStamp - g.lastT > 100 ? 0 : g.v; // finger paused → no flick
    const sameWay = Math.sign(v) === Math.sign(g.dx);
    const fling = sameWay && Math.abs(v) > FLING_V && Math.abs(g.dx) > 30;
    if (Math.abs(g.dx) >= fullAt() || fling) commit(side);
    else if (Math.abs(g.dx) >= OPEN_AT && !(!sameWay && Math.abs(v) > 0.3)) {
      setOpen(side);
      setDx(side === 'left' ? -ACTION_W : ACTION_W);
    } else close();
  };

  const date = inTrash && note.deletedAt ? note.deletedAt : note.updatedAt;

  return (
    <div ref={wrapRef} className={`note-card-wrap ${revealSide ? 'swiping' : ''} ${dragging ? 'dragging' : ''}`}>
      {revealSide && (
        <button
          type="button"
          className={`swipe-reveal ${revealSide} ${dragging && Math.abs(dx) >= fullAt() ? 'armed' : ''} ${open ? 'open' : ''}`}
          aria-hidden={open ? undefined : true}
          tabIndex={open ? 0 : -1}
          onClick={() => { if (open) commit(open); }}
        >
          <span className="swipe-action">
            {revealSide === 'right'
              ? (inTrash ? <><RotateCcw size={18}/>Restore</> : note.archived ? <><ArchiveRestore size={18}/>Unarchive</> : <><Archive size={18}/>Archive</>)
              : <><Trash2 size={18}/>{inTrash ? 'Delete' : 'Trash'}</>}
          </span>
        </button>
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
        onPointerUp={event => endGesture(event, false)}
        onPointerCancel={event => endGesture(event, true)}
        onTransitionEnd={event => {
          if (event.propertyName === 'transform' && dx === 0 && !open) setRevealSide(null);
        }}
        onContextMenu={event => {
          event.preventDefault();
          if (gesture.current || suppressClick.current) return; // touch long-press handles it
          props.onMenu(note.id, { x: event.clientX, y: event.clientY });
        }}
        onClick={event => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (open) { close(); return; }
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
