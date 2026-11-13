'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { History, RotateCcw } from 'lucide-react';
import { db } from '@/lib/firebase';
import type { Note, NoteVersion } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { htmlToMarkdown } from '@/lib/markdown';
import { Sheet } from './Dialog';

const KEEP = 50;

const REASON: Record<NoteVersion['reason'], string> = {
  auto: 'Snapshot',
  conflict: 'Edited on another device',
  restore: 'Before restoring',
};

export function VersionHistory({ note, onRestore, onClose }: {
  note: Note;
  onRestore: (version: NoteVersion) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDocs(query(collection(db, 'notes', note.id, 'versions'), orderBy('savedAt', 'desc'), limit(KEEP + 20)))
      .then(snap => {
        if (cancelled) return;
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as NoteVersion));
        setVersions(list.slice(0, KEEP));
        setSelected(list[0]?.id ?? null);
        // Prune very old snapshots so the subcollection stays small.
        list.slice(KEEP).forEach(v => deleteDoc(doc(db, 'notes', note.id, 'versions', v.id)).catch(() => undefined));
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : 'Could not load history.'));
    return () => { cancelled = true; };
  }, [note.id]);

  const current = versions?.find(v => v.id === selected) ?? null;
  const preview = useMemo(() => (current ? htmlToMarkdown(current.content) : ''), [current]);

  return (
    <Sheet title="Version history" onClose={onClose} wide icon={<History size={18}/>}>
      {error && <p className="modal-message error">{error}</p>}
      {!error && versions === null && <p className="modal-message">Loading…</p>}
      {versions && versions.length === 0 && (
        <p className="modal-message">
          No earlier versions yet. A snapshot is saved automatically while you edit (at most every 10 minutes),
          and whenever this note is changed on two devices at once.
        </p>
      )}
      {versions && versions.length > 0 && (
        <div className="history-layout">
          <div className="history-list" role="listbox" aria-label="Versions">
            {versions.map(v => (
              <button key={v.id} role="option" aria-selected={v.id === selected} className={v.id === selected ? 'active' : ''} onClick={() => setSelected(v.id)}>
                <strong>{dateTime(v.noteUpdatedAt || v.savedAt)}</strong>
                <small>{REASON[v.reason] ?? 'Snapshot'}</small>
              </button>
            ))}
          </div>
          <div className="history-preview">
            {current && (
              <>
                <h4>{current.title || 'Untitled note'}</h4>
                <pre>{preview}</pre>
                <div className="modal-actions">
                  <button className="primary-button" onClick={() => { onRestore(current); onClose(); }}>
                    <RotateCcw size={15}/> Restore this version
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
