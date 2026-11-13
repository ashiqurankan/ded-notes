'use client';

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import { Highlight } from './NoteCard';

export type Command = { id: string; label: string; icon: ReactNode; hint?: string; section: string; keywords?: string; run: () => void };
export type PaletteNote = { id: string; title: string; text: string; meta: string };

/** Spotlight-style palette: commands + note search, fully keyboard driven. */
export function CommandPalette({ commands, notes, onOpenNote, onClose }: {
  commands: Command[];
  notes: PaletteNote[];
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cmds = commands.filter(c => !q || `${c.label} ${c.keywords ?? ''} ${c.section}`.toLowerCase().includes(q));
    const matchedNotes = (q
      ? notes.filter(n => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q))
      : notes
    ).slice(0, q ? 12 : 6);
    const rows: Array<{ kind: 'cmd'; cmd: Command } | { kind: 'note'; note: PaletteNote } | { kind: 'section'; label: string }> = [];
    if (matchedNotes.length) {
      rows.push({ kind: 'section', label: q ? 'Notes' : 'Recent notes' });
      matchedNotes.forEach(note => rows.push({ kind: 'note', note }));
    }
    let section = '';
    cmds.slice(0, q ? 12 : 40).forEach(cmd => {
      if (cmd.section !== section) { section = cmd.section; rows.push({ kind: 'section', label: section }); }
      rows.push({ kind: 'cmd', cmd });
    });
    return rows;
  }, [commands, notes, query]);

  const selectable = results.filter(r => r.kind !== 'section');
  const current = selectable[Math.min(index, selectable.length - 1)];

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (row: typeof current) => {
    if (!row) return;
    onClose();
    if (row.kind === 'note') onOpenNote(row.note.id);
    else if (row.kind === 'cmd') row.cmd.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={18}/>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search notes or type a command…"
            aria-label="Search notes or commands"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(i => Math.min(i + 1, selectable.length - 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
              else if (event.key === 'Enter') { event.preventDefault(); run(current); }
              else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">No results for “{query}”</div>}
          {results.map((row, i) => {
            if (row.kind === 'section') return <div key={`s-${i}`} className="palette-section">{row.label}</div>;
            const active = row === current;
            if (row.kind === 'note') {
              return (
                <button key={`n-${row.note.id}`} role="option" aria-selected={active} className={`palette-row ${active ? 'active' : ''}`}
                  onPointerMove={() => setIndex(selectable.indexOf(row))} onClick={() => run(row)}>
                  <span className="palette-icon"><FileText size={16}/></span>
                  <span className="palette-text">
                    <strong><Highlight text={row.note.title} query={query.trim()}/></strong>
                    <small>{row.note.meta}</small>
                  </span>
                </button>
              );
            }
            return (
              <button key={`c-${row.cmd.id}`} role="option" aria-selected={active} className={`palette-row ${active ? 'active' : ''}`}
                onPointerMove={() => setIndex(selectable.indexOf(row))} onClick={() => run(row)}>
                <span className="palette-icon">{row.cmd.icon}</span>
                <span className="palette-text"><strong>{row.cmd.label}</strong></span>
                {row.cmd.hint && <kbd>{row.cmd.hint}</kbd>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
