'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Archive, ArrowDown, ArrowLeft, Bold, Check, CheckSquare, ChevronDown, Clock3, Cloud, Command, Download, FileText, Folder, FolderPlus, Hash, Image as ImageIcon, Italic, Laptop, List, ListOrdered, LogOut, Menu, Moon, MoreHorizontal, Pin, Plus, Search, Settings2, ShieldCheck, Sparkles, Sun, Trash2, Type, X } from 'lucide-react';
import { auth, db, firebaseConfigured, googleProvider } from '@/lib/firebase';
import { Folder as NoteFolder, Note, View } from '@/lib/types';
import { plainText, relativeDate } from '@/lib/format';

const starterContent = '<p>Every good idea starts somewhere.</p><p>Use this space to collect thoughts, make plans, and keep the little things from slipping away.</p>';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dark, setDark] = useState(() => {
    // The server renders the boot screen, so reading localStorage here
    // does not change the initial server/client markup.
    if (typeof window === 'undefined') return false;

    try {
      return window.localStorage.getItem('ded-notes-theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChanges = useRef<Record<string, { title?: string; content?: string }>>({});
  const editorRef = useRef<Editor | null>(null);
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const activeNote = notes.find(n => n.id === activeId) || null;

  useEffect(() => onAuthStateChanged(auth, u => { setUser(u); setAuthReady(true); }), []);

  useEffect(() => {
    if (!user) {
      setNotes([]);
      setFolders([]);
      setActiveId(null);
      return;
    }

    const nq = query(collection(db, 'notes'), where('ownerId', '==', user.uid));
    const fq = query(collection(db, 'folders'), where('ownerId', '==', user.uid));

    const unNotes = onSnapshot(nq, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Note))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // Apply remote body changes directly when the Firestore snapshot arrives.
      // This avoids relying only on a React effect to refresh Tiptap's internal
      // ProseMirror state. Local unsaved body edits remain protected.
      const currentId = activeIdRef.current;
      const currentNote = currentId ? list.find(n => n.id === currentId) : undefined;
      const pendingBody = currentId ? pendingChanges.current[currentId]?.content : undefined;

      if (currentNote && editorRef.current && pendingBody === undefined) {
        const remoteContent = currentNote.content || '<p></p>';

        if (editorRef.current.getHTML() !== remoteContent) {
          editorRef.current.commands.setContent(remoteContent, false);
        }
      }

      setNotes(list);

      setActiveId(current =>
        current && list.some(n => n.id === current)
          ? current
          : (list.find(n => !n.deleted && !n.archived)?.id || null)
      );
    }, e => setNotice(e.message));

    const unFolders = onSnapshot(
      fq,
      snap => setFolders(
        snap.docs
          .map(d => ({ id: d.id, ...d.data() } as NoteFolder))
          .sort((a, b) => a.name.localeCompare(b.name))
      ),
      e => setNotice(e.message)
    );

    return () => {
      unNotes();
      unFolders();
    };
  }, [user]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true })
    ],
    content: activeNote?.content || '',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'editor-prose',
        spellcheck: 'true',
        'aria-label': 'Note content'
      }
    },
    onUpdate: ({ editor: ed }) => {
      if (activeId) scheduleSave(activeId, undefined, ed.getHTML());
    },
  }, [activeId]);

  // Keep a stable reference for the Firestore listener callback.
  useEffect(() => {
    editorRef.current = editor;

    return () => {
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
    };
  }, [editor]);

  // Apply incoming Firestore changes to the currently open note.
  // Protect only fields that have unsaved local edits, rather than blocking
  // all remote updates whenever any field is being saved.
  useEffect(() => {
    if (!activeNote) {
      setTitleDraft('');
      return;
    }

    const pending = pendingChanges.current[activeNote.id];

    if (pending?.title === undefined) {
      setTitleDraft(activeNote.title || '');
    }

    if (editor && pending?.content === undefined) {
      const incomingContent = activeNote.content || '<p></p>';

      if (editor.getHTML() !== incomingContent) {
        editor.commands.setContent(incomingContent, false);
      }
    }
  }, [activeId, activeNote?.id, activeNote?.title, activeNote?.content, editor]);

  useEffect(() => {
    const theme = dark ? 'dark' : 'light';

    document.documentElement.dataset.theme = theme;

    try {
      window.localStorage.setItem('ded-notes-theme', theme);
    } catch {
      // Keep the app usable if browser storage is unavailable.
    }
  }, [dark]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        createNote();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search-box input')?.focus();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  useEffect(() => {
    if (!notice) return;

    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  function scheduleSave(id: string, title?: string, content?: string) {
    // Merge title and body edits for the same note.
    const existing = pendingChanges.current[id] || {};

    pendingChanges.current[id] = {
      ...existing,
      ...(title !== undefined ? { title } : {}),
      ...(content !== undefined ? { content } : {}),
    };

    if (saveTimer.current) clearTimeout(saveTimer.current);

    setSaving(true);

    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;

      const batch = pendingChanges.current;
      pendingChanges.current = {};

      try {
        await Promise.all(
          Object.entries(batch).map(([noteId, patch]) =>
            updateDoc(doc(db, 'notes', noteId), {
              ...patch,
              updatedAt: Date.now(),
            })
          )
        );
      } catch (e) {
        // Restore failed fields while preserving newer edits.
        for (const [noteId, failedPatch] of Object.entries(batch)) {
          pendingChanges.current[noteId] = {
            ...failedPatch,
            ...pendingChanges.current[noteId],
          };
        }

        setNotice(e instanceof Error ? e.message : 'Could not save note.');
      } finally {
        if (!saveTimer.current && Object.keys(pendingChanges.current).length === 0) {
          setSaving(false);
        } else if (!saveTimer.current && Object.keys(pendingChanges.current).length > 0) {
          setSaving(false);
        }
      }
    }, 550);
  }

  async function createNote() {
    if (!user) return;

    const now = Date.now();

    try {
      const ref = await addDoc(collection(db, 'notes'), {
        ownerId: user.uid,
        title: 'Untitled note',
        content: '<p></p>',
        folderId: view === 'folder' ? folderId : null,
        pinned: false,
        archived: false,
        deleted: false,
        tags: [],
        createdAt: now,
        updatedAt: now
      });

      setView('all');
      setActiveId(ref.id);
      setMobileEditorOpen(true);
      setSidebarOpen(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create note.');
    }
  }

  async function createFolder() {
    const name = folderName.trim();

    if (!name || !user) return;

    await addDoc(collection(db, 'folders'), {
      ownerId: user.uid,
      name,
      createdAt: Date.now()
    });

    setFolderName('');
    setFolderModal(false);
  }

  async function patchNote(patch: Partial<Note>) {
    if (activeNote) {
      await updateDoc(doc(db, 'notes', activeNote.id), {
        ...patch,
        updatedAt: Date.now()
      });
    }
  }

  async function removeNote(note: Note) {
    await updateDoc(doc(db, 'notes', note.id), {
      deleted: true,
      updatedAt: Date.now()
    });

    setActiveId(null);
  }

  async function restoreNote(note: Note) {
    await updateDoc(doc(db, 'notes', note.id), {
      deleted: false,
      updatedAt: Date.now()
    });
  }

  async function permanentlyDelete(note: Note) {
    await deleteDoc(doc(db, 'notes', note.id));
    setActiveId(null);
  }

  async function exportNote(format: 'pdf' | 'pages' | 'long') {
    if (!activeNote || exporting) return;

    setExporting(true);
    setExportOpen(false);

    let exportRoot: HTMLDivElement | null = null;

    try {
      const [{ default: html2canvas }, { jsPDF }, { default: JSZip }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
        import('jszip'),
      ]);

      const safeTitle = (titleDraft || activeNote.title || 'ded-notes')
        .replace(/[\\/:*?"<>|]+/g, '-')
        .trim()
        .slice(0, 80) || 'ded-notes';

      exportRoot = document.createElement('div');
      exportRoot.style.cssText = [
        'position:fixed', 'left:-100000px', 'top:0', 'width:794px',
        'box-sizing:border-box', 'padding:64px 72px', 'background:#ffffff',
        'color:#252820', 'font-family:Arial,Helvetica,sans-serif',
        'font-size:15px', 'line-height:1.8', 'overflow:visible',
      ].join(';');

      const exportDate = new Date(activeNote.createdAt).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
      const contentHtml = editor?.getHTML() || activeNote.content || '<p></p>';
      exportRoot.innerHTML = `
        <div style="font-size:12px;color:#858b7e;margin-bottom:22px">${exportDate}</div>
        <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:34px;line-height:1.2;letter-spacing:-1px;color:#252820;margin:0 0 24px;font-weight:700;overflow-wrap:anywhere"></h1>
        <div style="height:1px;background:#e6e8e2;margin:0 0 26px"></div>
        <article class="ded-export-content">${contentHtml}</article>
        <style>
          .ded-export-content{font-size:15px;line-height:1.8;color:#30342d;overflow-wrap:anywhere}
          .ded-export-content p{margin:0 0 16px}
          .ded-export-content h1,.ded-export-content h2,.ded-export-content h3{font-family:Arial,Helvetica,sans-serif;line-height:1.3;color:#252820;margin:24px 0 12px}
          .ded-export-content h1{font-size:28px}.ded-export-content h2{font-size:23px}.ded-export-content h3{font-size:19px}
          .ded-export-content ul,.ded-export-content ol{padding-left:26px;margin:10px 0 18px}
          .ded-export-content li{padding-left:4px;margin:4px 0}
          .ded-export-content a{color:#687b62;text-decoration:underline}
          .ded-export-content blockquote{border-left:3px solid #9aaa91;margin:18px 0;padding:4px 0 4px 18px;color:#666d60}
          .ded-export-content ul[data-type="taskList"]{list-style:none;padding:0}
          .ded-export-content ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:9px}
          .ded-export-content input[type="checkbox"]{margin-top:8px;accent-color:#687b62}
          .ded-export-content img{max-width:100%;height:auto}
          .ded-export-content pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f1;padding:14px;border-radius:8px}
          .ded-export-content code{font-family:monospace}
          .ded-export-content hr{border:0;border-top:1px solid #e6e8e2;margin:22px 0}
        </style>`;
      const heading = exportRoot.querySelector('h1');
      if (heading) heading.textContent = titleDraft || activeNote.title || 'Untitled note';
      document.body.appendChild(exportRoot);

      await Promise.all(Array.from(exportRoot.querySelectorAll('img')).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise<void>(resolve => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        });
      }));
      if (document.fonts?.ready) await document.fonts.ready;

      const rendered = await html2canvas(exportRoot, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        windowWidth: 794,
      });

      const pagePixelHeight = Math.floor(rendered.width * 297 / 210);
      const pageCount = Math.max(1, Math.ceil(rendered.height / pagePixelHeight));

      const makePageCanvas = (pageIndex: number) => {
        const y = pageIndex * pagePixelHeight;
        const height = Math.min(pagePixelHeight, rendered.height - y);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = rendered.width;
        pageCanvas.height = height;
        const context = pageCanvas.getContext('2d');
        if (!context) throw new Error('Could not prepare the export image.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        context.drawImage(rendered, 0, y, rendered.width, height, 0, 0, rendered.width, height);
        return pageCanvas;
      };

      const downloadBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      };

      if (format === 'long') {
        const blob = await new Promise<Blob>((resolve, reject) =>
          rendered.toBlob(result => result ? resolve(result) : reject(new Error('Could not create the image.')), 'image/png')
        );
        downloadBlob(blob, `${safeTitle}-long.png`);
      } else if (format === 'pages') {
        const zip = new JSZip();
        for (let index = 0; index < pageCount; index++) {
          const pageCanvas = makePageCanvas(index);
          const blob = await new Promise<Blob>((resolve, reject) =>
            pageCanvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not create a page image.')), 'image/png')
          );
          zip.file(`${safeTitle}-page-${String(index + 1).padStart(2, '0')}.png`, blob);
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `${safeTitle}-pages.zip`);
      } else {
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        for (let index = 0; index < pageCount; index++) {
          const pageCanvas = makePageCanvas(index);
          const image = pageCanvas.toDataURL('image/jpeg', 0.94);
          const heightMm = pageCanvas.height * 210 / pageCanvas.width;
          if (index > 0) pdf.addPage();
          pdf.addImage(image, 'JPEG', 0, 0, 210, heightMm, undefined, 'FAST');
        }
        pdf.save(`${safeTitle}.pdf`);
      }

      setNotice(format === 'pdf' ? 'PDF exported.' : format === 'pages' ? 'Page images exported as a ZIP.' : 'Long image exported.');
    } catch (error) {
      console.error('Note export failed:', error);
      setNotice(error instanceof Error ? `Export failed: ${error.message}` : 'Export failed. Please try again.');
    } finally {
      exportRoot?.remove();
      setExporting(false);
    }
  }

  const visibleNotes = useMemo(() => notes.filter(n => {
    if (view === 'trash') return n.deleted;
    if (view === 'archive') return n.archived && !n.deleted;
    if (n.deleted || n.archived) return false;
    if (view === 'pinned') return n.pinned;
    if (view === 'folder') return n.folderId === folderId;
    if (view === 'recent') return true;
    return true;
  }).filter(n =>
    !search ||
    `${n.title} ${plainText(n.content)}`.toLowerCase().includes(search.toLowerCase())
  ).sort((a, b) =>
    view === 'pinned'
      ? Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
      : b.updatedAt - a.updatedAt
  ), [notes, view, folderId, search]);

  const title = view === 'folder'
    ? folders.find(f => f.id === folderId)?.name || 'Folder'
    : ({
        all: 'All notes',
        pinned: 'Pinned',
        recent: 'Recently edited',
        archive: 'Archive',
        trash: 'Recently deleted'
      } as Record<string, string>)[view];

  async function login() {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Sign in failed.');
    }
  }

  if (!authReady) {
    return (
      <div className="boot">
        <div className="brand-mark">d</div>
        <span>Preparing your space…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <main className="login-screen">
        <div className="login-orb orb-one"/>
        <div className="login-orb orb-two"/>

        <div className="login-card">
          <div className="brand-lockup">
            <div className="brand-mark">d</div>
            <span>ded - notes</span>
          </div>

          <div className="login-art">
            <div className="paper paper-back"/>
            <div className="paper paper-front">
              <div className="paper-line wide"/>
              <div className="paper-line"/>
              <div className="paper-line short"/>
              <div className="paper-dot"/>
            </div>
            <div className="sparkle s-one">✳</div>
            <div className="sparkle s-two">✦</div>
          </div>

          <p className="eyebrow">A little room to think</p>
          <h1>Your thoughts,<br/><em>beautifully</em> kept.</h1>
          <p className="login-copy">
            A calm, personal space for notes, ideas and everything in between.
            Always with you, on every device.
          </p>

          <button className="google-button" onClick={login}>
            <GoogleIcon/>Continue with Google
          </button>

          <p className="privacy-note">
            <ShieldCheck size={14}/> Private by design. Only you can access your notes.
          </p>

          {!firebaseConfigured && (
            <p className="setup-warning">
              Firebase setup required — add your credentials to <code>.env.local</code>.
            </p>
          )}
        </div>

        <div className="login-footer">
          A quieter way to remember things <span>·</span> DED - NOTES
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <div className="brand-lockup">
            <div className="brand-mark">d</div>
            <span>ded - notes</span>
          </div>

          <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)}>
            <X size={18}/>
          </button>
        </div>

        <button className="new-note-button" onClick={createNote}>
          <Plus size={17}/> New note <span>⌘ N</span>
        </button>

        <div className="nav-group">
          <div className="nav-label">WORKSPACE</div>

          <NavButton
            icon={<FileText/>}
            label="All notes"
            count={notes.filter(n => !n.deleted && !n.archived).length}
            active={view === 'all'}
            onClick={() => {
              setView('all');
              setFolderId(null);
              setSidebarOpen(false);
            }}
          />

          <NavButton
            icon={<Pin/>}
            label="Pinned"
            active={view === 'pinned'}
            onClick={() => {
              setView('pinned');
              setSidebarOpen(false);
            }}
          />

          <NavButton
            icon={<Clock3/>}
            label="Recently edited"
            active={view === 'recent'}
            onClick={() => {
              setView('recent');
              setSidebarOpen(false);
            }}
          />
        </div>

        <div className="nav-group folder-group">
          <div className="nav-label">
            YOUR FOLDERS
            <button onClick={() => setFolderModal(true)} aria-label="Add folder">
              <Plus size={14}/>
            </button>
          </div>

          {folders.map(f => (
            <NavButton
              key={f.id}
              icon={<Folder/>}
              label={f.name}
              active={view === 'folder' && folderId === f.id}
              onClick={() => {
                setView('folder');
                setFolderId(f.id);
                setSidebarOpen(false);
              }}
            />
          ))}

          {folders.length === 0 && (
            <p className="empty-folders">Keep things together with folders.</p>
          )}
        </div>

        <div className="sidebar-bottom">
          <NavButton
            icon={<Archive/>}
            label="Archive"
            active={view === 'archive'}
            onClick={() => {
              setView('archive');
              setSidebarOpen(false);
            }}
          />

          <NavButton
            icon={<Trash2/>}
            label="Recently deleted"
            active={view === 'trash'}
            onClick={() => {
              setView('trash');
              setSidebarOpen(false);
            }}
          />
        </div>

        <div className="account-card">
          <div className="avatar">
            {user.photoURL
              ? <img src={user.photoURL} alt=""/>
              : user.displayName?.[0] || 'A'}
          </div>

          <div className="account-meta">
            <strong>{user.displayName || 'Your account'}</strong>
            <span>Personal workspace</span>
          </div>

          <button className="icon-button" title="Sign out" onClick={() => signOut(auth)}>
            <LogOut size={16}/>
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          className="scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <section className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)}>
              <Menu size={19}/>
            </button>

            <div className="breadcrumb">
              My workspace <span>/</span> <strong>{title}</strong>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="sync-status">
              <span className="sync-dot"/>
              {saving ? 'Saving…' : 'Synced'}
            </div>

            <button
              className="icon-button"
              onClick={() => setDark(!dark)}
              title="Toggle appearance"
            >
              {dark ? <Sun size={18}/> : <Moon size={18}/>}
            </button>

            <div className="avatar top-avatar">
              {user.photoURL
                ? <img src={user.photoURL} alt=""/>
                : user.displayName?.[0] || 'A'}
            </div>
          </div>
        </header>

        <div className={`workspace ${mobileEditorOpen ? 'mobile-editor-open' : ''}`}>
          <section className="notes-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">YOUR SPACE</p>
                <h2>{title}</h2>
                <p className="panel-subtitle">
                  {view === 'trash'
                    ? 'Notes stay here until you permanently delete them.'
                    : `${visibleNotes.length} ${visibleNotes.length === 1 ? 'note' : 'notes'} · A place for your thoughts`}
                </p>
              </div>

              <button className="create-square" onClick={createNote}>
                <Plus size={19}/>
              </button>
            </div>

            <div className="search-box">
              <Search size={16}/>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search your notes…"
              />
              <kbd>⌘ K</kbd>
            </div>

            <div className="note-list">
              {visibleNotes.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <FileText size={22}/>
                  </div>

                  <strong>{search ? 'No matching notes' : 'Nothing here just yet'}</strong>

                  <p>
                    {search
                      ? 'Try another search term.'
                      : 'Create a note and give your thoughts a home.'}
                  </p>

                  {!search && view !== 'trash' && (
                    <button onClick={createNote}>
                      <Plus size={15}/> Write your first note
                    </button>
                  )}
                </div>
              ) : (
                visibleNotes.map(note => (
                  <button
                    key={note.id}
                    className={`note-card ${activeId === note.id ? 'selected' : ''}`}
                    onClick={() => {
                      setActiveId(note.id);
                      setMobileEditorOpen(true);
                      setSidebarOpen(false);
                    }}
                  >
                    <div className="note-card-top">
                      <span className="note-card-title">
                        {note.title || 'Untitled note'}
                      </span>

                      {note.pinned && !note.deleted && (
                        <Pin size={13} className="pin-indicator"/>
                      )}
                    </div>

                    <p className="note-preview">
                      {plainText(note.content) || 'No additional text'}
                    </p>

                    <div className="note-card-meta">
                      <span>{relativeDate(note.updatedAt || Date.now())}</span>

                      {note.folderId && (
                        <span className="note-folder-chip">
                          <Folder size={11}/>
                          {folders.find(f => f.id === note.folderId)?.name || 'Folder'}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="list-footer">
              <span>
                {visibleNotes.length} {visibleNotes.length === 1 ? 'item' : 'items'}
              </span>
              <span>PRIVATE WORKSPACE</span>
            </div>
          </section>

          <section className="editor-panel">
            {activeNote && view !== 'trash' ? (
              <>
                <div className="editor-toolbar">
                  <div className="editor-tools">
                    <button
                      className="icon-button mobile-back"
                      onClick={() => setMobileEditorOpen(false)}
                      title="Back to notes"
                    >
                      <ArrowLeft size={18}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Bold"
                      onClick={() => editor?.chain().focus().toggleBold().run()}
                    >
                      <Bold size={16}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Italic"
                      onClick={() => editor?.chain().focus().toggleItalic().run()}
                    >
                      <Italic size={16}/>
                    </button>

                    <span className="tool-divider"/>

                    <button
                      className="tool-button"
                      title="Heading"
                      onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                    >
                      <Type size={17}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Bullet list"
                      onClick={() => editor?.chain().focus().toggleBulletList().run()}
                    >
                      <List size={17}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Numbered list"
                      onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                    >
                      <ListOrdered size={17}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Checklist"
                      onClick={() => editor?.chain().focus().toggleTaskList().run()}
                    >
                      <CheckSquare size={16}/>
                    </button>
                  </div>

                  <div className="editor-actions">
                    <label className="folder-select-wrap" title="Move to folder">
                      <Folder size={14}/>

                      <select
                        className="folder-select"
                        value={activeNote.folderId || ''}
                        onChange={e => patchNote({ folderId: e.target.value || null })}
                      >
                        <option value="">No folder</option>
                        {folders.map(f => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                    </label>

                    <button
                      className={`tool-button ${activeNote.pinned ? 'is-active' : ''}`}
                      title="Pin note"
                      onClick={() => patchNote({ pinned: !activeNote.pinned })}
                    >
                      <Pin size={16}/>
                    </button>

                    <button
                      className="tool-button"
                      title="Archive note"
                      onClick={async () => {
                        await patchNote({ archived: true });
                        setActiveId(null);
                      }}
                    >
                      <Archive size={16}/>
                    </button>

                    <div className="export-wrap">
                      <button
                        className="tool-button export-trigger"
                        title="Export note"
                        disabled={exporting}
                        onClick={() => setExportOpen(!exportOpen)}
                      >
                        <Download size={16}/>
                        <span>{exporting ? 'Exporting…' : 'Export'}</span>
                      </button>
                      {exportOpen && (
                        <div className="export-menu">
                          <button onClick={() => exportNote('pdf')}><FileText size={15}/> Export as PDF</button>
                          <button onClick={() => exportNote('pages')}><ImageIcon size={15}/> One image per page</button>
                          <button onClick={() => exportNote('long')}><ImageIcon size={15}/> One long image</button>
                        </div>
                      )}
                    </div>

                    <div className="more-wrap">
                      <button className="tool-button" onClick={() => setMoreOpen(!moreOpen)}>
                        <MoreHorizontal size={18}/>
                      </button>

                      {moreOpen && (
                        <div className="more-menu">
                          <button onClick={() => {
                            removeNote(activeNote);
                            setMoreOpen(false);
                          }}>
                            <Trash2 size={15}/> Move to trash
                          </button>

                          <button onClick={() => {
                            navigator.clipboard?.writeText(plainText(activeNote.content));
                            setMoreOpen(false);
                            setNotice('Note copied to clipboard.');
                          }}>
                            <FileText size={15}/> Copy plain text
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="editor-content">
                  <div className="note-date">
                    {new Date(activeNote.createdAt).toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </div>

                  <input
                    className="note-title-input"
                    value={titleDraft}
                    onChange={e => {
                      setTitleDraft(e.target.value);
                      scheduleSave(activeNote.id, e.target.value, undefined);
                    }}
                    placeholder="Untitled note"
                  />

                  <div className="editor-separator"/>

                  <EditorContent editor={editor}/>

                  <div className="editor-bottom">
                    <span>
                      <Cloud size={14}/>
                      {saving ? 'Saving changes' : 'All changes saved'}
                    </span>
                    <span>Just for you</span>
                  </div>
                </div>
              </>
            ) : view === 'trash' && activeNote ? (
              <div className="trash-detail">
                <Trash2 size={28}/>
                <h2>{activeNote.title}</h2>
                <p>This note is in Recently deleted.</p>

                <button className="primary-button" onClick={() => restoreNote(activeNote)}>
                  <Check size={16}/> Restore note
                </button>

                <button
                  className="text-button danger"
                  onClick={() => permanentlyDelete(activeNote)}
                >
                  Delete permanently
                </button>
              </div>
            ) : (
              <div className="editor-empty">
                <div className="empty-art">
                  <div className="empty-art-sheet">
                    <div/>
                    <div/>
                    <div/>
                  </div>
                  <Sparkles className="empty-spark" size={22}/>
                </div>

                <p className="eyebrow">A MOMENT TO THINK</p>
                <h2>Your next idea<br/><em>starts here.</em></h2>
                <p>
                  Select a note to pick up where you left off,<br/>
                  or create something new.
                </p>

                <button className="primary-button" onClick={createNote}>
                  <Plus size={16}/> Create a note
                </button>

                <div className="shortcut-hint">
                  <Command size={12}/> <span>+</span> <kbd>N</kbd> <span>to start writing</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>

      {folderModal && (
        <div className="modal-backdrop" onClick={() => setFolderModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-icon">
              <FolderPlus size={20}/>
            </div>

            <h3>Create a folder</h3>
            <p>Give your notes a little more structure.</p>

            <input
              autoFocus
              value={folderName}
              onChange={e => setFolderName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createFolder()}
              placeholder="e.g. Ideas, Journal, Work"
            />

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setFolderModal(false)}>
                Cancel
              </button>

              <button
                className="primary-button"
                onClick={createFolder}
                disabled={!folderName.trim()}
              >
                Create folder
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="toast">
          <span className="toast-dot"/>
          {notice}
          <button onClick={() => setNotice('')}>
            <X size={14}/>
          </button>
        </div>
      )}
    </main>
  );
}

function NavButton({
  icon,
  label,
  count,
  active,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-button ${active ? 'nav-active' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.25 5.48-4.73 7.18l7.65 5.94c4.47-4.13 7.12-10.2 7.12-17.59z"/>
      <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.81l-7.65-5.94c-2.13 1.43-4.86 2.27-8.25 2.27-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}