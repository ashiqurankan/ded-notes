'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  getRedirectResult, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, type User,
} from 'firebase/auth';
import {
  addDoc, clearIndexedDbPersistence, collection, deleteDoc, doc, getDocs, limit, onSnapshot, orderBy, query,
  setDoc, terminate, updateDoc, waitForPendingWrites, where, writeBatch, type DocumentData, type WriteBatch,
} from 'firebase/firestore';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Mark, type Editor } from '@tiptap/core';
import { EditorState, Selection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, Check, CheckCircle2, ChevronDown, Clock3,
  Cloud, CloudOff, Command as CommandIcon, Download, Edit3, FileJson, FileText, Folder, FolderInput, FolderPlus,
  Hash, Heading2, History, Image as ImageIcon, Keyboard, Link2, ListChecks, LogOut, Menu as MenuIcon, Monitor,
  Moon, MoreHorizontal, PanelLeft, Pin, PinOff, Plus, Printer, RotateCcw, Search, Share, ShieldCheck, Smartphone,
  Sparkles, Sun, Trash2, Upload, X,
} from 'lucide-react';
import { auth, authOnSameDomain, db, firebaseConfigured, googleProvider } from '@/lib/firebase';
import type { Folder as NoteFolder, Note, NoteVersion, SortMode, ThemePref, View } from '@/lib/types';
import { longDate, normalizeTag, plainText, relativeDate, wordCount } from '@/lib/format';
import {
  isAndroid, isApple, isIOS, isInAppBrowser, isModKey, isStandalone, shortcutLabel,
} from '@/lib/platform';
import type { ExportFormat } from '@/lib/exporters';
import { Menu, type MenuItem } from '@/components/Menu';
import { Dialog, Sheet, type DialogRequest } from '@/components/Dialog';
import { NoteCard } from '@/components/NoteCard';
import { FormatBar, readFormatState } from '@/components/FormatBar';
import { CommandPalette, type Command } from '@/components/CommandPalette';
import { TagEditor } from '@/components/TagEditor';

const VersionHistory = dynamic(() => import('@/components/VersionHistory').then(m => m.VersionHistory), { ssr: false });

/* ───────────────────────── constants & helpers ───────────────────────── */

const PAGE_SIZE = 300;
const SAVE_DELAY = 600;
const VERSION_INTERVAL = 10 * 60_000;
const TRASH_DAYS = 30;
const MAX_CONTENT = 900_000;
const SESSION_KEY = 'ded-notes-session';
const THEME_KEY = 'ded-notes-theme';
const DEVICE_KEY = 'ded-notes-device';
const EXPORT_DARK_KEY = 'ded-notes-export-dark';

type Patch = { title?: string; content?: string; tags?: string[] };
type Toast = { id: number; message: string; action?: { label: string; run: () => void }; duration: number };
type Layer = 'editor' | 'drawer';
type Session = { view?: View; folderId?: string | null; tag?: string | null; activeId?: string | null; sort?: SortMode; sidebarCollapsed?: boolean };
type MenuState =
  | { kind: 'more' | 'export' | 'account' | 'sort'; anchor: HTMLElement }
  | { kind: 'note'; point: { x: number; y: number }; id: string }
  | { kind: 'folder'; anchor?: HTMLElement; point?: { x: number; y: number }; id: string }
  | { kind: 'move'; anchor?: HTMLElement; point?: { x: number; y: number }; ids: string[] };
type SheetKind = 'shortcuts' | 'install' | null;
interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

const FontSize = Mark.create({
  name: 'fontSize',
  addAttributes() {
    return {
      fontSize: {
        default: null,
        parseHTML: element => (element as HTMLElement).style.fontSize || null,
        renderHTML: attributes => (attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {}),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[style*="font-size"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
});

function readJson<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function readRaw(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function getDeviceId() {
  if (typeof window === 'undefined') return 'server';
  let id = readRaw(DEVICE_KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeRaw(DEVICE_KEY, id);
  }
  return id;
}

function toMillis(value: unknown, fallback: number) {
  if (typeof value === 'number') return value;
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') return (value as { toMillis: () => number }).toMillis();
  return fallback;
}

function normalizeNote(id: string, data: DocumentData): Note {
  return {
    id,
    ownerId: data.ownerId,
    title: typeof data.title === 'string' ? data.title : '',
    content: typeof data.content === 'string' ? data.content : '',
    folderId: typeof data.folderId === 'string' ? data.folderId : null,
    pinned: Boolean(data.pinned),
    pinnedOrder: typeof data.pinnedOrder === 'number' ? data.pinnedOrder : undefined,
    archived: Boolean(data.archived),
    deleted: Boolean(data.deleted),
    deletedAt: typeof data.deletedAt === 'number' ? data.deletedAt : null,
    tags: Array.isArray(data.tags) ? data.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
    createdAt: toMillis(data.createdAt, 0),
    updatedAt: toMillis(data.updatedAt, 0),
    deviceId: typeof data.deviceId === 'string' ? data.deviceId : undefined,
    versionedAt: typeof data.versionedAt === 'number' ? data.versionedAt : undefined,
  };
}

const isEmptyHtml = (html: string) => !html || html === '<p></p>';
const displayTitle = (title: string) => (title.trim() ? title : 'Untitled note');
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return '';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/network-request-failed':
      return 'You appear to be offline. Connect to the internet to sign in.';
    case 'auth/unauthorized-domain':
      return 'This web address is not authorised for sign-in. Add it in Firebase → Authentication → Settings → Authorized domains.';
    case 'auth/web-storage-unsupported':
    case 'auth/operation-not-supported-in-this-environment':
      return 'Sign-in needs cookies and site data. Turn off private browsing or allow site data, then try again.';
    default:
      return error instanceof Error ? error.message : 'Sign in failed. Please try again.';
  }
}

/** Remove the editor's undo history (used when switching notes so ⌘Z never jumps into another note). */
function resetHistory(editor: Editor) {
  const { state } = editor;
  editor.view.updateState(EditorState.create({ doc: state.doc, plugins: state.plugins, schema: state.schema }));
}

function useMediaQuery(queryText: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(queryText);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, [queryText]);
  return matches;
}

/* ───────────────────────── component ───────────────────────── */

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const compact = useMediaQuery('(max-width: 760px), (max-height: 520px) and (pointer: coarse)');
  const drawerMode = useMediaQuery('(max-width: 1100px), (max-height: 520px) and (pointer: coarse)');
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  const session = useRef<Session>({});
  const deviceId = useRef('');

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [activeNotes, setActiveNotes] = useState<Note[]>([]);
  const [trashNotes, setTrashNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [limitCount, setLimitCount] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [fallbackQuery, setFallbackQuery] = useState(false);

  const [draftNote, setDraftNote] = useState<Note | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('updated');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [titleDraft, setTitleDraft] = useState('');

  const [themePref, setThemePref] = useState<ThemePref>('system');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [historyNoteId, setHistoryNoteId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportDark, setExportDark] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editorFocused, setEditorFocused] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncPending, setSyncPending] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Refs read by long-lived callbacks (editor, listeners, timers) so they never see stale state.
  const pending = useRef<Record<string, Patch>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<Note | null>(null);
  const persisted = useRef(new Set<string>());
  const notesById = useRef(new Map<string, Note>());
  const baseUpdated = useRef<Record<string, number>>({});
  const conflicts = useRef<Record<string, Note>>({});
  const activeIdRef = useRef<string | null>(null);
  const compactRef = useRef(false);
  const layers = useRef<Layer[]>([]);
  const traversing = useRef(false);
  const queuedLayers = useRef<Layer[]>([]);
  const loadedNoteId = useRef<string | null>(null);
  const sessionRestored = useRef(false);
  const purged = useRef(false);
  const handledParams = useRef(false);
  const lastSelected = useRef<string | null>(null);
  const dragNote = useRef<string | null>(null);
  const dragFolder = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions = useRef<any>({});

  activeIdRef.current = activeId;
  compactRef.current = compact;

  const notes = useMemo(() => [...activeNotes, ...trashNotes], [activeNotes, trashNotes]);
  const noteMap = useMemo(() => new Map(notes.map(n => [n.id, n])), [notes]);
  notesById.current = noteMap;
  const activeNote = (activeId && noteMap.get(activeId)) || (draftNote && draftNote.id === activeId ? draftNote : null);
  const resolvedDark = themePref === 'dark' || (themePref === 'system' && prefersDark);
  const mod = useCallback((keys: string[]) => (mounted ? shortcutLabel(keys) : ''), [mounted]);

  /* ───────────── one-time client setup ───────────── */

  useEffect(() => {
    session.current = readJson<Session>(SESSION_KEY, {});
    deviceId.current = getDeviceId();
    const s = session.current;
    if (s.view) setView(s.view);
    if (s.folderId !== undefined) setFolderId(s.folderId);
    if (s.tag !== undefined) setTagFilter(s.tag);
    if (s.sort) setSort(s.sort);
    if (s.sidebarCollapsed) setSidebarCollapsed(true);
    const theme = readRaw(THEME_KEY);
    if (theme === 'dark' || theme === 'light' || theme === 'system') setThemePref(theme);
    setExportDark(readRaw(EXPORT_DARK_KEY) === 'true');
    setOnline(navigator.onLine);
    history.replaceState({ ...(history.state || {}), dedDepth: 0 }, '');
    setMounted(true);
  }, []);

  const showToast = useCallback((message: string, action?: Toast['action'], duration?: number) => {
    setToast({ id: Date.now() + Math.random(), message, action, duration: duration ?? (action ? 6500 : 4200) });
  }, []);

  const confirmAsk = useCallback((options: Omit<DialogRequest, 'resolve' | 'input'>) =>
    new Promise<boolean>(resolve => setDialog({ ...options, resolve: value => resolve(value === true) })), []);

  const ask = useCallback((options: Omit<DialogRequest, 'resolve'> & { input: NonNullable<DialogRequest['input']> }) =>
    new Promise<string | null>(resolve => setDialog({ ...options, resolve: value => resolve(typeof value === 'string' ? value : null) })), []);

  /* ───────────── theme ───────────── */

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    root.dataset.theme = resolvedDark ? 'dark' : 'light';
    root.style.colorScheme = resolvedDark ? 'dark' : 'light';
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
      meta.content = resolvedDark ? '#171916' : '#f7f7f5';
    });
    writeRaw(THEME_KEY, themePref);
  }, [mounted, resolvedDark, themePref]);

  /* ───────────── auth ───────────── */

  useEffect(() => {
    if (!firebaseConfigured) { setAuthReady(true); return; }
    getRedirectResult(auth).catch(error => {
      const message = authErrorMessage(error);
      if (message) showToast(message, undefined, 8000);
    });
    return onAuthStateChanged(auth, next => { setUser(next); setAuthReady(true); });
  }, [showToast]);

  /* ───────────── Firestore subscriptions ───────────── */

  useEffect(() => {
    if (!user) {
      setActiveNotes([]); setTrashNotes([]); setFolders([]); setActiveId(null); setInitialLoaded(false);
      return;
    }
    const notesCol = collection(db, 'notes');
    const mine = where('ownerId', '==', user.uid);
    const activeQuery = fallbackQuery
      ? query(notesCol, mine, where('deleted', '==', false))
      : query(notesCol, mine, where('deleted', '==', false), orderBy('updatedAt', 'desc'), limit(limitCount));

    const unActive = onSnapshot(activeQuery, { includeMetadataChanges: true }, snap => {
      const list = snap.docs.map(d => normalizeNote(d.id, d.data()));
      for (const note of list) {
        const local = pending.current[note.id];
        const base = baseUpdated.current[note.id];
        if (local?.content !== undefined && base !== undefined && note.updatedAt > base && note.deviceId && note.deviceId !== deviceId.current) {
          conflicts.current[note.id] = note;
        }
      }
      setActiveNotes(list);
      setHasMore(!fallbackQuery && snap.size >= limitCount);
      setSyncPending(snap.metadata.hasPendingWrites);
      if (!snap.metadata.hasPendingWrites && !snap.metadata.fromCache) setLastSyncedAt(Date.now());
      setInitialLoaded(true);
    }, error => {
      if (error.code === 'failed-precondition' && !fallbackQuery) {
        console.warn('Firestore index missing — falling back to an unordered query.', error.message);
        setFallbackQuery(true);
      } else {
        showToast(error.message);
      }
    });

    const unTrash = onSnapshot(query(notesCol, mine, where('deleted', '==', true)), snap => {
      const list = snap.docs.map(d => normalizeNote(d.id, d.data()));
      setTrashNotes(list);
      if (!purged.current && !snap.metadata.fromCache) {
        purged.current = true;
        const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
        const expired = list.filter(n => (n.deletedAt ?? n.updatedAt) < cutoff).map(n => n.id);
        if (expired.length) actions.current.hardDelete(expired);
      }
    }, error => showToast(error.message));

    const unFolders = onSnapshot(query(collection(db, 'folders'), mine), snap => {
      setFolders(snap.docs
        .map(d => ({ id: d.id, ...d.data() } as NoteFolder))
        .sort((a, b) => (a.sortOrder ?? 999_999) - (b.sortOrder ?? 999_999) || a.name.localeCompare(b.name)));
    }, error => showToast(error.message));

    return () => { unActive(); unTrash(); unFolders(); };
  }, [user, limitCount, fallbackQuery, showToast]);

  // Once the draft shows up in Firestore it is a normal note.
  useEffect(() => {
    if (draftNote && noteMap.has(draftNote.id)) { draftRef.current = null; setDraftNote(null); }
  }, [draftNote, noteMap]);

  /* ───────────── derived lists ───────────── */

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 140);
    return () => window.clearTimeout(t);
  }, [search]);

  const q = debouncedSearch.trim().toLowerCase();
  const folderNameById = useMemo(() => new Map(folders.map(f => [f.id, f.name])), [folders]);

  const visibleNotes = useMemo(() => {
    const weekAgo = now - 7 * 86_400_000;
    let list = notes.filter(n => {
      if (view === 'trash') return n.deleted;
      if (n.deleted) return false;
      if (view === 'archive') return n.archived;
      if (n.archived) return false;
      if (view === 'pinned') return n.pinned;
      if (view === 'folder') return n.folderId === folderId;
      if (view === 'tag') return !!tagFilter && n.tags.includes(tagFilter);
      if (view === 'recent') return n.updatedAt >= weekAgo;
      return true;
    });
    if (q) list = list.filter(n => `${n.title} ${plainText(n.content)} ${n.tags.map(t => `#${t}`).join(' ')}`.toLowerCase().includes(q));

    const cmp = (a: Note, b: Note) => {
      if (view === 'trash') return (b.deletedAt ?? b.updatedAt) - (a.deletedAt ?? a.updatedAt);
      if (sort === 'title') return displayTitle(a.title).localeCompare(displayTitle(b.title), undefined, { sensitivity: 'base', numeric: true });
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    };
    const pinFirst = view === 'all' || view === 'folder' || view === 'tag' || view === 'pinned';
    list.sort((a, b) => {
      if (pinFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (pinFirst && a.pinned && b.pinned) return (a.pinnedOrder ?? 1e9) - (b.pinnedOrder ?? 1e9) || cmp(a, b);
      return cmp(a, b);
    });

    if (draftNote && !noteMap.has(draftNote.id) && !q && (view === 'all' || view === 'folder' || view === 'tag' || view === 'recent')) {
      list = [draftNote, ...list];
    }
    return list;
  }, [notes, noteMap, view, folderId, tagFilter, q, sort, draftNote, now]);

  const counts = useMemo(() => {
    const live = notes.filter(n => !n.deleted);
    const folderCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const n of live) {
      if (n.archived) continue;
      if (n.folderId) folderCounts.set(n.folderId, (folderCounts.get(n.folderId) ?? 0) + 1);
      n.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
    }
    return {
      all: live.filter(n => !n.archived).length,
      pinned: live.filter(n => n.pinned && !n.archived).length,
      archive: live.filter(n => n.archived).length,
      trash: notes.length - live.length,
      folderCounts,
      tags: Array.from(tagCounts.entries()).sort((a, b) => a[0].localeCompare(b[0])),
    };
  }, [notes]);

  const allTags = useMemo(() => counts.tags.map(([t]) => t), [counts.tags]);

  // Keep a sensible note selected; restore the last open note once.
  useEffect(() => {
    if (!user || !initialLoaded) return;
    const current = activeId ? noteMap.get(activeId) : null;
    const isDraft = draftNote && draftNote.id === activeId;
    if (isDraft) return;
    if (current && (view === 'trash' ? current.deleted : !current.deleted)) return;
    if (!sessionRestored.current) {
      sessionRestored.current = true;
      const restored = session.current.activeId ? noteMap.get(session.current.activeId) : null;
      if (restored && !restored.deleted) { setActiveId(restored.id); return; }
    }
    if (activeId && !current && !initialLoaded) return;
    setActiveId(compact ? null : visibleNotes.find(n => n.id !== draftNote?.id)?.id ?? null);
  }, [user, initialLoaded, activeId, noteMap, draftNote, view, compact, visibleNotes]);

  // Remember where the user was.
  useEffect(() => {
    if (!mounted || !user) return;
    writeJson(SESSION_KEY, {
      view, folderId, tag: tagFilter, sort, sidebarCollapsed,
      activeId: activeId && noteMap.has(activeId) ? activeId : session.current.activeId ?? null,
    } satisfies Session);
  }, [mounted, user, view, folderId, tagFilter, sort, sidebarCollapsed, activeId, noteMap]);

  /* ───────────── saving ───────────── */

  const failWrite = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    showToast(/permission/i.test(message)
      ? `Couldn't save to the cloud (permission denied). Check that firestore.rules from this project is published. ${message}`
      : `Couldn't save to the cloud: ${message}`, undefined, 9000);
  }, [showToast]);

  function saveVersion(note: Note, reason: NoteVersion['reason'], content = note.content, title = note.title) {
    if (!user || !plainText(content) && !title.trim()) return;
    addDoc(collection(db, 'notes', note.id, 'versions'), {
      ownerId: user.uid, title, content, savedAt: Date.now(), noteUpdatedAt: note.updatedAt || Date.now(), reason,
    }).catch(() => undefined);
  }

  function writeNote(id: string, patch: Patch) {
    if (!user) return;
    const now2 = Date.now();
    const existing = notesById.current.get(id);

    if (!existing && !persisted.current.has(id)) {
      const draft = draftRef.current;
      if (!draft || draft.id !== id) return;
      const next: Note = { ...draft, ...patch };
      draftRef.current = next;
      const hasContent = next.title.trim() || plainText(next.content) || next.tags.length || /<(img|hr|li)/i.test(next.content);
      if (!hasContent) return;
      persisted.current.add(id);
      baseUpdated.current[id] = now2;
      const { id: _id, ...data } = next;
      setDoc(doc(db, 'notes', id), { ...data, title: next.title, content: next.content || '<p></p>', updatedAt: now2, deviceId: deviceId.current })
        .catch(error => { persisted.current.delete(id); failWrite(error); });
      return;
    }

    if (patch.content !== undefined && patch.content.length > MAX_CONTENT) {
      showToast('This note is too large to sync (over ~900 KB). Split it into smaller notes.', undefined, 9000);
      return;
    }

    const extra: Record<string, unknown> = {};
    const conflict = conflicts.current[id];
    if (conflict && patch.content !== undefined) {
      delete conflicts.current[id];
      saveVersion(conflict, 'conflict');
      showToast('This note was also changed on another device. Their version was saved to Version history.', {
        label: 'View', run: () => setHistoryNoteId(id),
      }, 9000);
    } else if (existing && patch.content !== undefined && plainText(existing.content)
      && now2 - (existing.versionedAt ?? existing.createdAt) > VERSION_INTERVAL) {
      saveVersion(existing, 'auto');
      extra.versionedAt = now2;
    }
    baseUpdated.current[id] = now2;
    updateDoc(doc(db, 'notes', id), { ...patch, ...extra, updatedAt: now2, deviceId: deviceId.current }).catch(failWrite);
  }

  function flush() {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const batch = pending.current;
    pending.current = {};
    setPendingCount(0);
    for (const [id, patch] of Object.entries(batch)) writeNote(id, patch);
  }

  function scheduleSave(id: string, patch: Patch) {
    pending.current[id] = { ...pending.current[id], ...patch };
    setPendingCount(Object.keys(pending.current).length);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => actions.current.flush(), SAVE_DELAY);
  }

  function commitChunks(ops: Array<(batch: WriteBatch) => void>) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach(op => op(batch));
      batch.commit().catch(failWrite);
    }
  }

  /** Update existing notes (drafts are updated locally). `touch` bumps updatedAt. */
  function updateNotes(ids: string[], patch: Partial<Note>, touch = true) {
    const ops: Array<(b: WriteBatch) => void> = [];
    for (const id of ids) {
      if (!notesById.current.has(id) && !persisted.current.has(id)) {
        if (draftRef.current?.id === id) {
          draftRef.current = { ...draftRef.current, ...patch } as Note;
          setDraftNote(draftRef.current);
        }
        continue;
      }
      ops.push(b => b.update(doc(db, 'notes', id), { ...patch, ...(touch ? { updatedAt: Date.now(), deviceId: deviceId.current } : {}) }));
    }
    if (ops.length) commitChunks(ops);
  }

  // Flush pending edits when the app is hidden or closed (phones kill background tabs).
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') actions.current.flush(); };
    const onPageHide = () => actions.current.flush();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) { actions.current.flush(); event.preventDefault(); }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  /* ───────────── editor ───────────── */

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      FontSize,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: '',
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'editor-prose', spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': 'Note content', role: 'textbox', 'aria-multiline': 'true' },
      scrollThreshold: 90,
      scrollMargin: 90,
      handleClick: (_view, _pos, event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (anchor?.href && (event.metaKey || event.ctrlKey)) {
          window.open(anchor.href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const id = activeIdRef.current;
      if (id) actions.current.scheduleSave(id, { content: ed.getHTML() });
    },
    onFocus: () => setEditorFocused(true),
    onBlur: () => {
      window.setTimeout(() => {
        if (!document.activeElement?.closest('.keyboard-bar')) setEditorFocused(false);
      }, 120);
    },
  }, []);

  const format = useEditorState({ editor, selector: ({ editor: e }) => readFormatState(e) });
  const words = useEditorState({ editor, selector: ({ editor: e }) => (e ? wordCount(e.getText()) : 0) }) ?? 0;

  // Load the selected note into the (single, long-lived) editor, and apply remote changes.
  useEffect(() => {
    if (!editor) return;
    if (!activeNote) {
      if (loadedNoteId.current) {
        loadedNoteId.current = null;
        editor.commands.setContent('', false);
        resetHistory(editor);
      }
      setTitleDraft('');
      return;
    }
    const local = pending.current[activeNote.id];
    if (loadedNoteId.current !== activeNote.id) {
      loadedNoteId.current = activeNote.id;
      editor.commands.setContent(activeNote.content || '', false);
      resetHistory(editor);
      baseUpdated.current[activeNote.id] = activeNote.updatedAt;
      setTitleDraft(activeNote.title === 'Untitled note' ? '' : activeNote.title);
      return;
    }
    if (local?.content === undefined) {
      const incoming = activeNote.content || '<p></p>';
      const currentHtml = editor.getHTML();
      if (currentHtml !== incoming && !(isEmptyHtml(currentHtml) && isEmptyHtml(incoming))) {
        const { from, to } = editor.state.selection;
        editor.chain().setMeta('addToHistory', false).setContent(incoming, false).run();
        if (editor.isFocused) {
          const size = editor.state.doc.content.size;
          editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
        }
        baseUpdated.current[activeNote.id] = activeNote.updatedAt;
      }
    }
    if (local?.title === undefined && draftRef.current?.id !== activeNote.id) {
      setTitleDraft(activeNote.title === 'Untitled note' ? '' : activeNote.title);
    }
  }, [editor, activeNote?.id, activeNote?.content, activeNote?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───────────── navigation (with Android back / iOS swipe-back support) ───────────── */

  function pushLayer(layer: Layer) {
    if (layers.current.includes(layer) || queuedLayers.current.includes(layer)) return;
    // A history.go() from closeLayers is still in flight: push after it lands,
    // otherwise the traversal would pop the entry we are about to add.
    if (traversing.current) { queuedLayers.current.push(layer); return; }
    layers.current.push(layer);
    history.pushState({ ...(history.state || {}), dedDepth: layers.current.length }, '');
  }

  function drainQueuedLayers() {
    traversing.current = false;
    const queued = queuedLayers.current;
    queuedLayers.current = [];
    queued.forEach(layer => pushLayer(layer));
  }

  function closeLayers(which: Layer[]) {
    const index = layers.current.findIndex(l => which.includes(l));
    if (which.includes('editor')) setMobileEditorOpen(false);
    if (which.includes('drawer')) setSidebarOpen(false);
    if (index < 0) return;
    const count = layers.current.length - index;
    layers.current = layers.current.slice(0, index);
    traversing.current = true;
    history.go(-count);
    window.setTimeout(() => { if (traversing.current) actions.current.drainQueuedLayers(); }, 700);
  }

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const depth = (event.state as { dedDepth?: number } | null)?.dedDepth ?? 0;
      if (depth < layers.current.length) layers.current = layers.current.slice(0, depth);
      actions.current.drainQueuedLayers();
      setMobileEditorOpen(layers.current.includes('editor'));
      setSidebarOpen(layers.current.includes('drawer'));
      setMenu(null);
      if (!layers.current.includes('editor')) actions.current.flush();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function openEditorLayer() {
    if (!compactRef.current) return;
    setMobileEditorOpen(true);
    pushLayer('editor');
  }

  function closeEditor() {
    flush();
    closeLayers(['editor']);
  }

  function openDrawer() {
    setSidebarOpen(true);
    pushLayer('drawer');
  }

  function toggleSidebar() {
    if (drawerMode) { if (sidebarOpen) closeLayers(['drawer']); else openDrawer(); }
    else setSidebarCollapsed(c => !c);
  }

  function discardEmptyDraft(exceptId?: string) {
    const draft = draftRef.current;
    if (draft && draft.id !== exceptId && !persisted.current.has(draft.id)) {
      draftRef.current = null;
      setDraftNote(null);
    }
  }

  function selectNote(id: string) {
    if (id !== activeIdRef.current) { flush(); discardEmptyDraft(id); }
    setActiveId(id);
    setMenu(null);
    openEditorLayer();
  }

  function goTo(next: View, options: { folderId?: string | null; tag?: string | null } = {}) {
    flush();
    discardEmptyDraft();
    setView(next);
    setFolderId(options.folderId ?? null);
    setTagFilter(options.tag ?? null);
    setSelecting(false);
    setSelectedIds(new Set());
    setActiveId(null);
    closeLayers(['editor', 'drawer']);
  }

  function createNote(options: { title?: string; content?: string; persist?: boolean } = {}) {
    if (!user) return;
    flush();
    discardEmptyDraft();
    const id = doc(collection(db, 'notes')).id;
    const time = Date.now();
    const draft: Note = {
      id, ownerId: user.uid, title: options.title ?? '', content: options.content ?? '<p></p>',
      folderId: view === 'folder' ? folderId : null,
      pinned: false, pinnedOrder: 0, archived: false, deleted: false, deletedAt: null,
      tags: view === 'tag' && tagFilter ? [tagFilter] : [],
      createdAt: time, updatedAt: time, deviceId: deviceId.current,
    };
    draftRef.current = draft;
    setDraftNote(draft);
    if (view === 'trash' || view === 'archive' || view === 'pinned') setView('all');
    setSearch('');
    setSelecting(false);
    setActiveId(id);
    if (options.persist) writeNote(id, {});
    closeLayers(['drawer']);
    openEditorLayer();
    window.setTimeout(() => titleRef.current?.focus(), 80);
  }

  function selectNeighbour(removed: string[]) {
    if (!activeIdRef.current || !removed.includes(activeIdRef.current)) return;
    if (compactRef.current) { closeLayers(['editor']); setActiveId(null); return; }
    const index = visibleNotes.findIndex(n => n.id === activeIdRef.current);
    const after = visibleNotes.slice(index + 1).find(n => !removed.includes(n.id));
    const before = visibleNotes.slice(0, Math.max(0, index)).reverse().find(n => !removed.includes(n.id));
    setActiveId(after?.id ?? before?.id ?? null);
  }

  /* ───────────── note actions ───────────── */

  function trashNotesById(ids: string[]) {
    if (!ids.length) return;
    flush();
    const draft = draftRef.current;
    if (draft && ids.includes(draft.id) && !persisted.current.has(draft.id)) discardEmptyDraft();
    selectNeighbour(ids);
    const time = Date.now();
    updateNotes(ids, { deleted: true, deletedAt: time });
    exitSelection();
    showToast(`Moved ${ids.length === 1 ? 'note' : `${ids.length} notes`} to Recently deleted.`, {
      label: 'Undo', run: () => updateNotes(ids, { deleted: false, deletedAt: null }),
    });
  }

  function archiveNotes(ids: string[], archived: boolean) {
    if (!ids.length) return;
    flush();
    if (view !== 'archive' || !archived) selectNeighbour(ids);
    updateNotes(ids, { archived });
    exitSelection();
    showToast(`${ids.length === 1 ? 'Note' : `${ids.length} notes`} ${archived ? 'archived' : 'moved back to notes'}.`, {
      label: 'Undo', run: () => updateNotes(ids, { archived: !archived }),
    });
  }

  function restoreNotes(ids: string[]) {
    if (!ids.length) return;
    selectNeighbour(ids);
    updateNotes(ids, { deleted: false, deletedAt: null });
    exitSelection();
    showToast(`Restored ${ids.length === 1 ? 'note' : `${ids.length} notes`}.`, {
      label: 'Show', run: () => { goTo('all'); setActiveId(ids[0]); openEditorLayer(); },
    });
  }

  function hardDelete(ids: string[]) {
    if (!ids.length) return;
    // Delete each note together with its version history in one batch. (The rules for
    // versions check the parent note, so the note must still exist when they're evaluated.)
    ids.forEach(id => {
      const noteRef = doc(db, 'notes', id);
      getDocs(collection(db, 'notes', id, 'versions'))
        .catch(() => null)
        .then(snap => {
          const batch = writeBatch(db);
          snap?.docs.slice(0, 450).forEach(v => batch.delete(v.ref));
          batch.delete(noteRef);
          return batch.commit();
        })
        .catch(() => deleteDoc(noteRef).catch(failWrite));
    });
  }

  async function deleteForever(ids: string[]) {
    if (!ids.length) return;
    const ok = await confirmAsk({
      title: ids.length === 1 ? 'Delete this note permanently?' : `Delete ${ids.length} notes permanently?`,
      message: 'This can’t be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
      icon: <Trash2 size={20}/>,
    });
    if (!ok) return;
    selectNeighbour(ids);
    hardDelete(ids);
    exitSelection();
    showToast(`Permanently deleted ${ids.length === 1 ? 'note' : `${ids.length} notes`}.`);
  }

  function pinNotes(ids: string[], pinned: boolean) {
    let order = Math.max(-1, ...notes.filter(n => n.pinned && !n.deleted).map(n => n.pinnedOrder ?? 0));
    ids.forEach(id => updateNotes([id], pinned ? { pinned, pinnedOrder: ++order } : { pinned }, false));
    exitSelection();
  }

  function orderedPinned() {
    return notes.filter(n => n.pinned && !n.archived && !n.deleted)
      .sort((a, b) => (a.pinnedOrder ?? 1e9) - (b.pinnedOrder ?? 1e9) || b.updatedAt - a.updatedAt);
  }

  function writePinnedOrder(list: Note[]) {
    commitChunks(list.map((n, index) => (b: WriteBatch) => b.update(doc(db, 'notes', n.id), { pinnedOrder: index })));
  }

  function reorderPinned(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const list = orderedPinned();
    const from = list.findIndex(n => n.id === sourceId);
    const to = list.findIndex(n => n.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    writePinnedOrder(list);
  }

  function movePinned(id: string, direction: -1 | 1) {
    const list = orderedPinned();
    const from = list.findIndex(n => n.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    writePinnedOrder(list);
  }

  function moveToFolder(ids: string[], target: string | null) {
    updateNotes(ids, { folderId: target });
    exitSelection();
    const name = target ? folderNameById.get(target) : null;
    showToast(ids.length === 1 ? `Moved to ${name ?? 'No folder'}.` : `Moved ${ids.length} notes to ${name ?? 'No folder'}.`);
  }

  function setNoteTags(id: string, tags: string[]) {
    scheduleSave(id, { tags });
    flush();
  }

  /* ───────────── folders ───────────── */

  async function createFolder(thenMove?: string[]) {
    if (!user) return;
    const name = await ask({
      title: 'New folder',
      message: 'Give your notes a little more structure.',
      icon: <FolderPlus size={20}/>,
      input: { placeholder: 'e.g. Ideas, Journal, Work', maxLength: 60 },
      confirmLabel: 'Create folder',
    });
    if (!name) return;
    if (folders.some(f => f.name.toLowerCase() === name.toLowerCase())) { showToast(`A folder called “${name}” already exists.`); return; }
    const ref = doc(collection(db, 'folders'));
    setDoc(ref, { ownerId: user.uid, name, sortOrder: folders.length, createdAt: Date.now() }).catch(failWrite);
    if (thenMove?.length) moveToFolder(thenMove, ref.id);
  }

  async function renameFolder(folder: NoteFolder) {
    const name = await ask({
      title: 'Rename folder',
      icon: <Edit3 size={20}/>,
      input: { initial: folder.name, maxLength: 60 },
      confirmLabel: 'Rename',
    });
    if (!name || name === folder.name) return;
    updateDoc(doc(db, 'folders', folder.id), { name }).catch(failWrite);
  }

  async function deleteFolder(folder: NoteFolder) {
    if (!user) return;
    const count = counts.folderCounts.get(folder.id) ?? 0;
    const ok = await confirmAsk({
      title: `Delete folder “${folder.name}”?`,
      message: count ? `Its ${count} ${count === 1 ? 'note' : 'notes'} will be kept and moved to All notes.` : 'This folder is empty.',
      confirmLabel: 'Delete folder',
      danger: true,
      icon: <Trash2 size={20}/>,
    });
    if (!ok) return;
    try {
      const snap = await getDocs(query(collection(db, 'notes'), where('ownerId', '==', user.uid), where('folderId', '==', folder.id)));
      const ops: Array<(b: WriteBatch) => void> = snap.docs.map(d => (b: WriteBatch) => b.update(d.ref, { folderId: null }));
      ops.push(b => b.delete(doc(db, 'folders', folder.id)));
      commitChunks(ops);
      if (view === 'folder' && folderId === folder.id) goTo('all');
      showToast('Folder deleted. Its notes were kept in All notes.');
    } catch (error) {
      failWrite(error);
    }
  }

  function writeFolderOrder(list: NoteFolder[]) {
    commitChunks(list.map((f, sortOrder) => (b: WriteBatch) => b.update(doc(db, 'folders', f.id), { sortOrder })));
  }

  function reorderFolders(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const list = [...folders];
    const from = list.findIndex(f => f.id === sourceId);
    const to = list.findIndex(f => f.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    writeFolderOrder(list);
  }

  function moveFolder(id: string, direction: -1 | 1) {
    const list = [...folders];
    const from = list.findIndex(f => f.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    writeFolderOrder(list);
  }

  /* ───────────── selection ───────────── */

  function exitSelection() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string, range: boolean) {
    setSelecting(true);
    setSelectedIds(current => {
      const next = new Set(current);
      if (range && lastSelected.current) {
        const ids = visibleNotes.map(n => n.id);
        const a = ids.indexOf(lastSelected.current);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => next.add(x));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelected.current = id;
  }

  const selectedList = useMemo(() => visibleNotes.filter(n => selectedIds.has(n.id) && noteMap.has(n.id)).map(n => n.id), [visibleNotes, selectedIds, noteMap]);

  /* ───────────── editor extras ───────────── */

  async function openLinkDialog() {
    if (!editor) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    const { from, to, empty } = editor.state.selection;
    const url = await ask({
      title: previous ? 'Edit link' : 'Add link',
      icon: <Link2 size={20}/>,
      input: { initial: previous ?? '', placeholder: 'https://example.com', type: 'url', maxLength: 2000 },
      confirmLabel: 'Save link',
      extras: previous ? [
        { label: 'Remove', danger: true, onClick: () => editor.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').unsetLink().run() },
        { label: 'Open', onClick: () => window.open(previous, '_blank', 'noopener,noreferrer') },
      ] : undefined,
    });
    if (!url) return;
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (/^(javascript|data|vbscript):/i.test(href)) return;
    const chain = editor.chain().focus().setTextSelection({ from, to });
    if (empty && !previous) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] }).run();
    else chain.extendMarkRange('link').setLink({ href }).run();
  }

  /** Focus the body synchronously so the very next keystroke lands in the note, not the title. */
  function focusEditorStart() {
    if (!editor) return;
    const { state, view } = editor;
    view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)));
    view.focus();
  }

  async function copyPlainText() {
    const body = editor?.getText({ blockSeparator: '\n' }) ?? plainText(activeNote?.content);
    const text = [titleDraft.trim(), body.trim()].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied as plain text.');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      showToast(ok ? 'Copied as plain text.' : 'Couldn’t access the clipboard on this device.');
    }
  }

  function printNote() {
    flush();
    if (isIOS() && isStandalone()) {
      showToast('Printing isn’t available in the installed iPhone/iPad app. Export as PDF, then print from the share sheet.', undefined, 8000);
      return;
    }
    window.print();
  }

  async function offerFile(blob: Blob, filename: string, label: string) {
    const { deliverFile } = await import('@/lib/exporters');
    if (coarse && typeof navigator.share === 'function') {
      // Share needs a fresh tap on iOS, so hand the user a button.
      showToast(`${label} is ready.`, {
        label: 'Save / Share',
        run: () => { deliverFile(blob, filename, true).catch(error => showToast(String(error))); },
      }, 20_000);
    } else {
      await deliverFile(blob, filename, false);
      showToast(`${label} downloaded.`);
    }
  }

  async function exportCurrent(formatKind: ExportFormat) {
    if (!activeNote || exporting) return;
    flush();
    const html = editor?.getHTML() ?? activeNote.content;
    if (!plainText(html) && !titleDraft.trim()) { showToast('Write something before exporting this note.'); return; }
    setExporting(true);
    try {
      const { exportNoteFile } = await import('@/lib/exporters');
      const { blob, filename } = await exportNoteFile({
        title: titleDraft.trim() || 'Untitled note', html, createdAt: activeNote.createdAt, format: formatKind, dark: exportDark,
      });
      await offerFile(blob, filename, formatKind === 'pdf' ? 'PDF' : formatKind === 'pages' ? 'Page images' : 'Long image');
    } catch (error) {
      console.error('Note export failed:', error);
      showToast(error instanceof Error ? `Export failed: ${error.message}` : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function exportAll(kind: 'markdown' | 'json') {
    if (!user) return;
    flush();
    showToast('Preparing your backup…');
    try {
      const snap = await getDocs(query(collection(db, 'notes'), where('ownerId', '==', user.uid)));
      const all = snap.docs.map(d => normalizeNote(d.id, d.data()));
      const ex = await import('@/lib/exporters');
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = kind === 'json' ? ex.buildJsonBackup(all, folders) : await ex.buildMarkdownZip(all, folders);
      await offerFile(blob, `ded-notes-backup-${stamp}.${kind === 'json' ? 'json' : 'zip'}`, 'Backup');
    } catch (error) {
      showToast(error instanceof Error ? `Backup failed: ${error.message}` : 'Backup failed.');
    }
  }

  async function importFiles(fileList: FileList | null) {
    if (!user || !fileList?.length) return;
    try {
      const ex = await import('@/lib/exporters');
      const items = (await ex.parseImportFiles(Array.from(fileList)));
      const usable = items.filter(i => i.content.length <= MAX_CONTENT);
      if (!usable.length) { showToast('No notes found. Import .md, .txt, .html, a ded - notes .json backup, or a .zip of them.'); return; }
      const ok = await confirmAsk({
        title: `Import ${usable.length} ${usable.length === 1 ? 'note' : 'notes'}?`,
        message: `They’ll be added alongside your existing notes.${items.length > usable.length ? ` ${items.length - usable.length} very large file(s) will be skipped.` : ''}`,
        confirmLabel: 'Import',
        icon: <Upload size={20}/>,
      });
      if (!ok) return;
      const byName = new Map(folders.map(f => [f.name.toLowerCase(), f.id]));
      const ops: Array<(b: WriteBatch) => void> = [];
      let order = folders.length;
      for (const name of Array.from(new Set(usable.map(i => i.folderName).filter((n): n is string => !!n)))) {
        if (byName.has(name.toLowerCase())) continue;
        const ref = doc(collection(db, 'folders'));
        byName.set(name.toLowerCase(), ref.id);
        const sortOrder = order++;
        ops.push(b => b.set(ref, { ownerId: user.uid, name: name.slice(0, 60), sortOrder, createdAt: Date.now() }));
      }
      let pinOrder = notes.filter(n => n.pinned).length;
      for (const item of usable) {
        const ref = doc(collection(db, 'notes'));
        const pinnedOrder = item.pinned ? pinOrder++ : 0;
        ops.push(b => b.set(ref, {
          ownerId: user.uid,
          title: item.title.slice(0, 300),
          content: item.content || '<p></p>',
          folderId: item.folderName ? byName.get(item.folderName.toLowerCase()) ?? null : null,
          pinned: item.pinned, pinnedOrder, archived: item.archived, deleted: false, deletedAt: null,
          tags: Array.from(new Set(item.tags.map(normalizeTag).filter(Boolean))).slice(0, 30),
          createdAt: item.createdAt, updatedAt: item.updatedAt, deviceId: deviceId.current,
        }));
      }
      commitChunks(ops);
      showToast(`Imported ${usable.length} ${usable.length === 1 ? 'note' : 'notes'}.`);
    } catch (error) {
      showToast(error instanceof Error ? `Import failed: ${error.message}` : 'Import failed.');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  function restoreVersion(version: NoteVersion) {
    if (!activeNote || !editor) return;
    flush();
    saveVersion({ ...activeNote, updatedAt: Date.now() }, 'restore', editor.getHTML(), titleDraft);
    setTitleDraft(version.title);
    scheduleSave(activeNote.id, { title: version.title });
    editor.commands.setContent(version.content || '<p></p>', true);
    flush();
    showToast('Version restored. The previous text was saved to Version history.');
  }

  /* ───────────── auth actions ───────────── */

  async function login() {
    if (signingIn || !firebaseConfigured) return;
    setSigningIn(true);
    const sameDomain = authOnSameDomain();
    try {
      if (sameDomain && (isStandalone() || isIOS() || isAndroid())) {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      let failure: unknown = error;
      const code = (error as { code?: string })?.code;
      if (sameDomain && (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment')) {
        try { await signInWithRedirect(auth, googleProvider); return; } catch (redirectError) { failure = redirectError; }
      }
      const message = authErrorMessage(failure);
      if (message) showToast(message, undefined, 9000);
    } finally {
      setSigningIn(false);
    }
  }

  async function logout() {
    flush();
    let synced = true;
    try {
      await Promise.race([
        waitForPendingWrites(db),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
    } catch { synced = false; }
    if (!synced) {
      const ok = await confirmAsk({
        title: 'Some changes haven’t synced yet',
        message: 'You seem to be offline. If you sign out now, edits made on this device since going offline will be lost.',
        confirmLabel: 'Sign out anyway',
        danger: true,
        icon: <CloudOff size={20}/>,
      });
      if (!ok) return;
    }
    setSigningOut(true);
    try {
      await signOut(auth);
      await terminate(db);
      // Remove the offline copy of the notes from this browser (shared computers).
      await clearIndexedDbPersistence(db);
    } catch (error) {
      console.warn('Sign-out cleanup failed', error);
    }
    try { window.localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    window.location.replace('/');
  }

  /* ───────────── PWA: service worker, install, share target ───────────── */

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations().then(list => list.forEach(r => r.unregister())).catch(() => undefined);
      return;
    }
    let reloadRequested = false;
    const onControllerChange = () => { if (reloadRequested) window.location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    const version = process.env.NEXT_PUBLIC_BUILD_ID || 'v2';
    let registration: ServiceWorkerRegistration | null = null;
    const offer = (worker: ServiceWorker) => showToast('A new version of ded - notes is ready.', {
      label: 'Reload',
      run: () => { actions.current.flush(); reloadRequested = true; worker.postMessage('SKIP_WAITING'); },
    }, 120_000);
    const onVisible = () => { if (document.visibilityState === 'visible') registration?.update().catch(() => undefined); };
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: '/' }).then(reg => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
        });
      });
    }).catch(() => undefined);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [showToast]);

  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallEvent(event as BeforeInstallPromptEvent); };
    const onInstalled = () => { setInstallEvent(null); showToast('ded - notes was installed.'); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [showToast]);

  const canInstall = mounted && !isStandalone() && (!!installEvent || isIOS());

  async function install() {
    if (installEvent) {
      await installEvent.prompt().catch(() => undefined);
      setInstallEvent(null);
    } else {
      setSheet('install');
    }
  }

  // Share target (“Share → ded - notes”) and the “New note” app shortcut.
  useEffect(() => {
    if (!user || !initialLoaded || handledParams.current) return;
    handledParams.current = true;
    const params = new URLSearchParams(window.location.search);
    const title = params.get('title') ?? '';
    const text = params.get('text') ?? '';
    const url = params.get('url') ?? '';
    const wantsNew = params.has('new');
    if (!title && !text && !url && !wantsNew) return;
    history.replaceState({ dedDepth: 0 }, '', '/');
    if (title || text || url) {
      const paragraphs = text.split(/\r?\n/).filter(Boolean).map(line => `<p>${escapeHtml(line)}</p>`);
      if (/^https?:\/\//i.test(url)) paragraphs.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`);
      actions.current.createNote({ title: title.slice(0, 300), content: paragraphs.join('') || '<p></p>', persist: true });
      showToast('Saved what you shared as a new note.');
    } else {
      actions.current.createNote();
    }
  }, [user, initialLoaded, showToast]);

  /* ───────────── environment listeners ───────────── */

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(current => (current?.id === toast.id ? null : current)), toast.duration);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Track the on-screen keyboard (iOS doesn't resize the layout) so the format bar sits on top of it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${Math.round(keyboard)}px`);
      document.documentElement.classList.toggle('kb-open', keyboard > 80);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => actions.current.onKey?.(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function onKey(event: KeyboardEvent) {
    if (!user || dialog || sheet || historyNoteId) return;
    const modDown = isModKey(event);
    const target = event.target as HTMLElement;
    const typing = !!target.closest?.('input, textarea, select, [contenteditable="true"]');
    const inEditor = !!target.closest?.('.ProseMirror');
    const key = event.key.toLowerCase();

    if (modDown && event.code === 'KeyN' && !event.shiftKey) { event.preventDefault(); createNote(); return; }
    if (modDown && key === 'k' && inEditor) { event.preventDefault(); openLinkDialog(); return; }
    if (modDown && (key === 'k' || key === '/')) { event.preventDefault(); setPaletteOpen(open => !open); return; }
    if (modDown && key === 's') { event.preventDefault(); flush(); showToast('Saved.'); return; }
    if (modDown && key === '\\') { event.preventDefault(); toggleSidebar(); return; }
    if (modDown && event.shiftKey && key === 'f') { event.preventDefault(); searchRef.current?.focus(); return; }
    if (modDown && key === 'backspace' && !typing && activeId) {
      event.preventDefault();
      if (view === 'trash') deleteForever([activeId]); else trashNotesById([activeId]);
      return;
    }
    if (typing || paletteOpen || menu) return;
    if (key === '/') { event.preventDefault(); searchRef.current?.focus(); return; }
    if (key === 'escape' && selecting) { exitSelection(); return; }
    if ((key === 'arrowdown' || key === 'arrowup') && !modDown && visibleNotes.length) {
      event.preventDefault();
      const index = visibleNotes.findIndex(n => n.id === activeId);
      const next = visibleNotes[Math.max(0, Math.min(visibleNotes.length - 1, index + (key === 'arrowdown' ? 1 : -1)))];
      if (next) { flush(); setActiveId(next.id); document.querySelector(`[data-note-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (key === 'enter' && activeId && !compact) { event.preventDefault(); editor?.commands.focus('end'); }
  }

  // Keep long-lived callbacks pointing at the latest closures.
  actions.current = { flush, scheduleSave, createNote, hardDelete, onKey, drainQueuedLayers };

  /* ───────────── commands for the palette ───────────── */

  function buildCommands(): Command[] {
    if (!user) return [];
    const list: Command[] = [
      { id: 'new', section: 'Actions', label: 'New note', icon: <Plus size={16}/>, hint: mod(['mod', 'alt', 'N']), run: () => createNote() },
      { id: 'new-folder', section: 'Actions', label: 'New folder…', icon: <FolderPlus size={16}/>, run: () => createFolder() },
      { id: 'search', section: 'Actions', label: 'Search in list', icon: <Search size={16}/>, hint: '/', run: () => window.setTimeout(() => searchRef.current?.focus(), 30) },
      { id: 'select', section: 'Actions', label: 'Select notes', icon: <ListChecks size={16}/>, run: () => setSelecting(true) },
      { id: 'sidebar', section: 'Actions', label: 'Toggle sidebar', icon: <PanelLeft size={16}/>, hint: mod(['mod', '\\']), run: () => toggleSidebar() },
      { id: 'theme-system', section: 'Appearance', label: 'Appearance: Match system', icon: <Monitor size={16}/>, run: () => setThemePref('system') },
      { id: 'theme-light', section: 'Appearance', label: 'Appearance: Light', icon: <Sun size={16}/>, run: () => setThemePref('light') },
      { id: 'theme-dark', section: 'Appearance', label: 'Appearance: Dark', icon: <Moon size={16}/>, run: () => setThemePref('dark') },
      { id: 'go-all', section: 'Go to', label: 'All notes', icon: <FileText size={16}/>, run: () => goTo('all') },
      { id: 'go-pinned', section: 'Go to', label: 'Pinned', icon: <Pin size={16}/>, run: () => goTo('pinned') },
      { id: 'go-recent', section: 'Go to', label: 'Recently edited', icon: <Clock3 size={16}/>, run: () => goTo('recent') },
      { id: 'go-archive', section: 'Go to', label: 'Archive', icon: <Archive size={16}/>, run: () => goTo('archive') },
      { id: 'go-trash', section: 'Go to', label: 'Recently deleted', icon: <Trash2 size={16}/>, run: () => goTo('trash') },
      ...folders.map(f => ({ id: `folder-${f.id}`, section: 'Go to', label: f.name, keywords: 'folder', icon: <Folder size={16}/>, run: () => goTo('folder', { folderId: f.id }) })),
      ...allTags.map(t => ({ id: `tag-${t}`, section: 'Go to', label: `#${t}`, keywords: 'tag', icon: <Hash size={16}/>, run: () => goTo('tag', { tag: t }) })),
      { id: 'backup-md', section: 'Backup', label: 'Export all notes as Markdown (.zip)', icon: <Download size={16}/>, run: () => exportAll('markdown') },
      { id: 'backup-json', section: 'Backup', label: 'Export all notes as JSON', icon: <FileJson size={16}/>, run: () => exportAll('json') },
      { id: 'import', section: 'Backup', label: 'Import notes…', icon: <Upload size={16}/>, run: () => importRef.current?.click() },
    ];
    if (activeNote && !activeNote.deleted) {
      list.splice(2, 0,
        { id: 'pin', section: 'This note', label: activeNote.pinned ? 'Unpin note' : 'Pin note', icon: <Pin size={16}/>, run: () => pinNotes([activeNote.id], !activeNote.pinned) },
        { id: 'archive', section: 'This note', label: activeNote.archived ? 'Unarchive note' : 'Archive note', icon: <Archive size={16}/>, run: () => archiveNotes([activeNote.id], !activeNote.archived) },
        { id: 'history', section: 'This note', label: 'Version history', icon: <History size={16}/>, run: () => setHistoryNoteId(activeNote.id) },
        { id: 'export-pdf', section: 'This note', label: 'Export as PDF', icon: <FileText size={16}/>, run: () => exportCurrent('pdf') },
        { id: 'copy', section: 'This note', label: 'Copy as plain text', icon: <FileText size={16}/>, run: () => copyPlainText() },
        { id: 'print', section: 'This note', label: 'Print…', icon: <Printer size={16}/>, run: () => printNote() },
        { id: 'trash', section: 'This note', label: 'Move to trash', icon: <Trash2 size={16}/>, hint: mod(['mod', '⌫']), run: () => trashNotesById([activeNote.id]) },
      );
    }
    if (canInstall) list.push({ id: 'install', section: 'App', label: 'Install app', icon: <Smartphone size={16}/>, run: () => install() });
    list.push({ id: 'shortcuts', section: 'App', label: 'Keyboard shortcuts', icon: <Keyboard size={16}/>, run: () => setSheet('shortcuts') });
    list.push({ id: 'signout', section: 'App', label: 'Sign out', icon: <LogOut size={16}/>, run: () => logout() });
    return list;
  }

  const paletteNotes = useMemo(() => notes
    .filter(n => !n.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(n => ({
      id: n.id,
      title: displayTitle(n.title),
      text: `${plainText(n.content)} ${n.tags.map(t => `#${t}`).join(' ')}`,
      meta: [relativeDate(n.updatedAt, now), n.archived ? 'Archive' : n.folderId ? folderNameById.get(n.folderId) : null].filter(Boolean).join(' · '),
    })), [notes, now, folderNameById]);

  /* ───────────── menus ───────────── */

  function menuItems(state: MenuState): MenuItem[] {
    switch (state.kind) {
      case 'more': {
        if (!activeNote) return [];
        return [
          { label: 'Version history', icon: <History size={15}/>, onSelect: () => setHistoryNoteId(activeNote.id) },
          { label: 'Copy as plain text', icon: <FileText size={15}/>, onSelect: copyPlainText },
          { label: 'Print…', icon: <Printer size={15}/>, onSelect: printNote, hint: mod(['mod', 'P']) },
          ...(compact ? [
            { divider: true } as MenuItem,
            { heading: 'EXPORT NOTE' } as MenuItem,
            { label: 'Export as PDF', icon: <FileText size={15}/>, onSelect: () => exportCurrent('pdf'), disabled: exporting },
            { label: 'One image per page', icon: <ImageIcon size={15}/>, onSelect: () => exportCurrent('pages'), disabled: exporting },
            { label: 'One long image', icon: <ImageIcon size={15}/>, onSelect: () => exportCurrent('long'), disabled: exporting },
            { label: 'Dark background', checked: exportDark, icon: <span/>, keepOpen: true, onSelect: () => { setExportDark(!exportDark); writeRaw(EXPORT_DARK_KEY, String(!exportDark)); } },
          ] : []),
          { divider: true },
          { label: 'Move to trash', icon: <Trash2 size={15}/>, danger: true, hint: mod(['mod', '⌫']), onSelect: () => trashNotesById([activeNote.id]) },
        ];
      }
      case 'export':
        return [
          { label: 'Export as PDF', icon: <FileText size={15}/>, onSelect: () => exportCurrent('pdf') },
          { label: 'One image per page (.zip)', icon: <ImageIcon size={15}/>, onSelect: () => exportCurrent('pages') },
          { label: 'One long image', icon: <ImageIcon size={15}/>, onSelect: () => exportCurrent('long') },
          { divider: true },
          { label: 'Dark background', checked: exportDark, icon: <span/>, keepOpen: true, onSelect: () => { setExportDark(!exportDark); writeRaw(EXPORT_DARK_KEY, String(!exportDark)); } },
        ];
      case 'sort':
        return [
          { heading: 'SORT BY' },
          { label: 'Date edited', checked: sort === 'updated', icon: <span/>, onSelect: () => setSort('updated') },
          { label: 'Date created', checked: sort === 'created', icon: <span/>, onSelect: () => setSort('created') },
          { label: 'Title', checked: sort === 'title', icon: <span/>, onSelect: () => setSort('title') },
          { divider: true },
          { label: selecting ? 'Done selecting' : 'Select notes', icon: <ListChecks size={15}/>, onSelect: () => (selecting ? exitSelection() : setSelecting(true)) },
        ];
      case 'account':
        return [
          { heading: (user?.email ?? user?.displayName ?? 'ACCOUNT').toUpperCase() },
          { label: 'Match system', checked: themePref === 'system', icon: <Monitor size={15}/>, onSelect: () => setThemePref('system') },
          { label: 'Light', checked: themePref === 'light', icon: <Sun size={15}/>, onSelect: () => setThemePref('light') },
          { label: 'Dark', checked: themePref === 'dark', icon: <Moon size={15}/>, onSelect: () => setThemePref('dark') },
          { divider: true },
          { label: 'Export all as Markdown', icon: <Download size={15}/>, onSelect: () => exportAll('markdown') },
          { label: 'Export all as JSON', icon: <FileJson size={15}/>, onSelect: () => exportAll('json') },
          { label: 'Import notes…', icon: <Upload size={15}/>, onSelect: () => importRef.current?.click() },
          { divider: true },
          ...(canInstall ? [{ label: 'Install app', icon: <Smartphone size={15}/>, onSelect: install } as MenuItem] : []),
          ...(finePointer ? [{ label: 'Keyboard shortcuts', icon: <Keyboard size={15}/>, onSelect: () => setSheet('shortcuts') } as MenuItem] : []),
          { label: 'Sign out', icon: <LogOut size={15}/>, onSelect: logout },
        ];
      case 'note': {
        const note = noteMap.get(state.id) ?? (draftNote?.id === state.id ? draftNote : null);
        if (!note) return [];
        if (note.deleted) {
          return [
            { label: 'Restore', icon: <RotateCcw size={15}/>, onSelect: () => restoreNotes([note.id]) },
            { label: 'Delete permanently', icon: <Trash2 size={15}/>, danger: true, onSelect: () => deleteForever([note.id]) },
          ];
        }
        const pinnedList = orderedPinned();
        const pinIndex = pinnedList.findIndex(n => n.id === note.id);
        return [
          { label: 'Open', icon: <FileText size={15}/>, onSelect: () => selectNote(note.id) },
          { label: note.pinned ? 'Unpin' : 'Pin to top', icon: note.pinned ? <PinOff size={15}/> : <Pin size={15}/>, onSelect: () => pinNotes([note.id], !note.pinned) },
          ...(note.pinned && !note.archived ? [
            { label: 'Move up', icon: <ArrowUp size={15}/>, disabled: pinIndex <= 0, onSelect: () => movePinned(note.id, -1) } as MenuItem,
            { label: 'Move down', icon: <ArrowDown size={15}/>, disabled: pinIndex < 0 || pinIndex >= pinnedList.length - 1, onSelect: () => movePinned(note.id, 1) } as MenuItem,
          ] : []),
          { label: 'Move to folder…', icon: <FolderInput size={15}/>, onSelect: () => setMenu({ kind: 'move', point: state.point, ids: [note.id] }) },
          { label: note.archived ? 'Unarchive' : 'Archive', icon: note.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>, onSelect: () => archiveNotes([note.id], !note.archived) },
          { label: 'Select', icon: <ListChecks size={15}/>, onSelect: () => toggleSelected(note.id, false) },
          { divider: true },
          { label: 'Move to trash', icon: <Trash2 size={15}/>, danger: true, onSelect: () => trashNotesById([note.id]) },
        ];
      }
      case 'move': {
        const current = state.ids.length === 1 ? (noteMap.get(state.ids[0]) ?? draftNote)?.folderId ?? null : undefined;
        return [
          { heading: 'MOVE TO' },
          { label: 'No folder', checked: current === null, icon: <FileText size={15}/>, onSelect: () => moveToFolder(state.ids, null) },
          ...folders.map(f => ({ label: f.name, checked: current === f.id, icon: <Folder size={15}/>, onSelect: () => moveToFolder(state.ids, f.id) } as MenuItem)),
          { divider: true },
          { label: 'New folder…', icon: <FolderPlus size={15}/>, onSelect: () => createFolder(state.ids) },
        ];
      }
      case 'folder': {
        const folder = folders.find(f => f.id === state.id);
        if (!folder) return [];
        const index = folders.indexOf(folder);
        return [
          { label: 'Rename…', icon: <Edit3 size={15}/>, onSelect: () => renameFolder(folder) },
          { label: 'Move up', icon: <ArrowUp size={15}/>, disabled: index === 0, onSelect: () => moveFolder(folder.id, -1) },
          { label: 'Move down', icon: <ArrowDown size={15}/>, disabled: index === folders.length - 1, onSelect: () => moveFolder(folder.id, 1) },
          { divider: true },
          { label: 'Delete folder', icon: <Trash2 size={15}/>, danger: true, onSelect: () => deleteFolder(folder) },
        ];
      }
    }
  }

  const closeMenu = useCallback(() => setMenu(null), []);

  /* ───────────── render ───────────── */

  const syncState = pendingCount > 0 ? 'saving' : !online ? 'offline' : syncPending ? 'syncing' : 'synced';
  const syncLabel = {
    saving: 'Saving…',
    offline: 'Offline · saved on this device',
    syncing: 'Syncing…',
    synced: lastSyncedAt ? `Synced ${relativeDate(lastSyncedAt, now).toLowerCase()}` : 'Synced',
  }[syncState];

  if (!authReady || signingOut) {
    return (
      <div className="boot" role="status">
        <div className="brand-mark">d</div>
        <span>{signingOut ? 'Signing out…' : 'Preparing your space…'}</span>
      </div>
    );
  }

  if (!user) {
    const inApp = mounted && isInAppBrowser();
    return (
      <main className="login-screen">
        <div className="login-orb orb-one"/>
        <div className="login-orb orb-two"/>

        <div className="login-card">
          <div className="brand-lockup">
            <div className="brand-mark">d</div>
            <span>ded - notes</span>
          </div>

          <div className="login-art" aria-hidden="true">
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

          <p className="eyebrow">A LITTLE ROOM TO THINK</p>
          <h1>Your thoughts,<br/><em>beautifully</em> kept.</h1>
          <p className="login-copy">
            A calm, personal space for notes, ideas and everything in between.
            Always with you, on every device.
          </p>

          {inApp && (
            <div className="setup-warning" role="alert">
              Google doesn’t allow sign-in inside this app’s built-in browser.
              Open this page in {isIOS() ? 'Safari' : 'Chrome or your default browser'} (use the ••• or share menu → “Open in browser”).
              <button className="text-button" onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => showToast('Link copied.'), () => undefined)}>Copy link</button>
            </div>
          )}

          <button className="google-button" onClick={login} disabled={signingIn || !firebaseConfigured}>
            <GoogleIcon/>{signingIn ? 'Opening Google…' : 'Continue with Google'}
          </button>

          <p className="privacy-note">
            <ShieldCheck size={14}/> Private by design. Only you can access your notes.
          </p>

          {!firebaseConfigured && (
            <p className="setup-warning">
              Firebase setup required — add your credentials to <code>.env.local</code> (or your Vercel project’s environment variables).
            </p>
          )}
        </div>

        <div className="login-footer">
          A quieter way to remember things <span>·</span> DED - NOTES
        </div>

        {toast && <ToastView toast={toast} onClose={() => setToast(null)}/>}
      </main>
    );
  }

  const viewTitle = view === 'folder'
    ? folderNameById.get(folderId ?? '') || 'Folder'
    : view === 'tag' ? `#${tagFilter ?? ''}`
    : ({ all: 'All notes', pinned: 'Pinned', recent: 'Recently edited', archive: 'Archive', trash: 'Recently deleted' } as Record<string, string>)[view];

  const editingNote = activeNote && !activeNote.deleted ? activeNote : null;
  const trashNote = activeNote && activeNote.deleted && view === 'trash' ? activeNote : null;
  const showPinnedLabels = (view === 'all' || view === 'folder' || view === 'tag') && !q && visibleNotes.some(n => n.pinned) && visibleNotes.some(n => !n.pinned);
  const newNoteHint = mod(['mod', 'alt', 'N']);

  return (
    <main className={`app-shell ${sidebarCollapsed && !drawerMode ? 'sidebar-collapsed' : ''} ${drawerMode ? 'drawer-mode' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Navigation" aria-hidden={drawerMode && !sidebarOpen ? true : undefined}>
        <div className="sidebar-top">
          <div className="brand-lockup">
            <div className="brand-mark">d</div>
            <span>ded - notes</span>
          </div>
          <button className="icon-button mobile-close" aria-label="Close sidebar" onClick={() => closeLayers(['drawer'])}>
            <X size={18}/>
          </button>
        </div>

        <button className="new-note-button" onClick={() => createNote()}>
          <Plus size={17}/> New note {finePointer && <span>{newNoteHint}</span>}
        </button>

        <nav className="sidebar-scroll">
          <div className="nav-group">
            <div className="nav-label">WORKSPACE</div>
            <NavButton icon={<FileText/>} label="All notes" count={counts.all} active={view === 'all'} onClick={() => goTo('all')}/>
            <NavButton icon={<Pin/>} label="Pinned" count={counts.pinned || undefined} active={view === 'pinned'} onClick={() => goTo('pinned')}/>
            <NavButton icon={<Clock3/>} label="Recently edited" active={view === 'recent'} onClick={() => goTo('recent')}/>
          </div>

          <div className="nav-group folder-group">
            <div className="nav-label">
              YOUR FOLDERS
              <button onClick={() => createFolder()} aria-label="New folder" title="New folder">
                <Plus size={15}/>
              </button>
            </div>

            {folders.map(f => (
              <div
                key={f.id}
                className="folder-row"
                draggable={finePointer}
                onDragStart={() => { dragFolder.current = f.id; }}
                onDragOver={event => { if (dragFolder.current) event.preventDefault(); }}
                onDrop={() => { if (dragFolder.current) reorderFolders(dragFolder.current, f.id); dragFolder.current = null; }}
                onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'folder', id: f.id, point: { x: event.clientX, y: event.clientY } }); }}
              >
                <NavButton
                  icon={<Folder/>}
                  label={f.name}
                  count={counts.folderCounts.get(f.id)}
                  active={view === 'folder' && folderId === f.id}
                  onClick={() => goTo('folder', { folderId: f.id })}
                />
                <button
                  className="folder-more-button"
                  aria-label={`Folder options for ${f.name}`}
                  title="Folder options"
                  onClick={event => setMenu({ kind: 'folder', id: f.id, anchor: event.currentTarget })}
                >
                  <MoreHorizontal size={15}/>
                </button>
              </div>
            ))}

            {folders.length === 0 && <p className="empty-folders">Keep things together with folders.</p>}
          </div>

          {counts.tags.length > 0 && (
            <div className="nav-group">
              <div className="nav-label">TAGS</div>
              <div className="tag-cloud">
                {counts.tags.map(([t, c]) => (
                  <button key={t} className={`tag-pill ${view === 'tag' && tagFilter === t ? 'active' : ''}`} onClick={() => goTo('tag', { tag: t })}>
                    #{t} <small>{c}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>

        <div className="sidebar-bottom">
          <NavButton icon={<Archive/>} label="Archive" count={counts.archive || undefined} active={view === 'archive'} onClick={() => goTo('archive')}/>
          <NavButton icon={<Trash2/>} label="Recently deleted" count={counts.trash || undefined} active={view === 'trash'} onClick={() => goTo('trash')}/>
        </div>

        <button className="account-card" onClick={event => setMenu({ kind: 'account', anchor: event.currentTarget })} aria-label="Account and settings">
          <Avatar user={user}/>
          <div className="account-meta">
            <strong>{user.displayName || 'Your account'}</strong>
            <span>Settings &amp; backup</span>
          </div>
          <ChevronDown size={15} className="account-chevron"/>
        </button>
      </aside>

      {drawerMode && sidebarOpen && (
        <button className="scrim" onClick={() => closeLayers(['drawer'])} aria-label="Close navigation" tabIndex={-1}/>
      )}

      <section className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" onClick={toggleSidebar} aria-label="Toggle sidebar" title={`Toggle sidebar (${mod(['mod', '\\'])})`}>
              {drawerMode ? <MenuIcon size={19}/> : <PanelLeft size={18}/>}
            </button>
            <div className="breadcrumb">
              <span className="crumb-root">My workspace</span><span className="crumb-sep">/</span><strong>{viewTitle}</strong>
            </div>
          </div>

          <div className="topbar-actions">
            <div className={`sync-status ${syncState}`} title={syncLabel} role="status" aria-live="polite">
              {syncState === 'offline' ? <CloudOff size={14}/> : <span className="sync-dot"/>}
              <span className="sync-label">{syncLabel}</span>
            </div>
            <button className="palette-button" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
              <Search size={15}/>
              <span>Search</span>
              {finePointer && <kbd>{mod(['mod', 'K'])}</kbd>}
            </button>
            <button
              className="icon-button"
              onClick={() => setThemePref(resolvedDark ? 'light' : 'dark')}
              aria-label={resolvedDark ? 'Switch to light appearance' : 'Switch to dark appearance'}
              title="Toggle appearance"
            >
              {resolvedDark ? <Sun size={18}/> : <Moon size={18}/>}
            </button>
          </div>
        </header>

        <div className={`workspace ${mobileEditorOpen ? 'mobile-editor-open' : ''}`}>
          <section className="notes-panel" aria-label="Notes">
            <div className="panel-heading">
              <div className="panel-heading-text">
                <p className="eyebrow">YOUR SPACE</p>
                <h2>{viewTitle}</h2>
                <p className="panel-subtitle">
                  {view === 'trash'
                    ? `Notes are permanently removed after ${TRASH_DAYS} days.`
                    : `${visibleNotes.length} ${visibleNotes.length === 1 ? 'note' : 'notes'} · A place for your thoughts`}
                </p>
              </div>
              <div className="panel-actions">
                <button className="create-square subtle" onClick={event => setMenu({ kind: 'sort', anchor: event.currentTarget })} aria-label="Sort and select" title="Sort and select">
                  <ArrowUpDown size={16}/>
                </button>
                {view === 'trash' ? (
                  <button className="empty-trash-button" onClick={() => deleteForever(trashNotes.map(n => n.id))} disabled={!trashNotes.length} title="Permanently delete all recently deleted notes">
                    <Trash2 size={14}/><span>Empty</span>
                  </button>
                ) : (
                  <button className="create-square" onClick={() => createNote()} aria-label="New note" title={`New note (${newNoteHint})`}>
                    <Plus size={19}/>
                  </button>
                )}
              </div>
            </div>

            <div className="search-box">
              <Search size={16}/>
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') { setSearch(''); event.currentTarget.blur(); }
                  if (event.key === 'Enter' && visibleNotes[0]) selectNote(visibleNotes[0].id);
                }}
                placeholder="Search your notes…"
                aria-label="Search notes"
                enterKeyHint="search"
              />
              {search ? (
                <button className="search-clear" onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label="Clear search"><X size={14}/></button>
              ) : finePointer && <kbd>/</kbd>}
            </div>

            {selecting && (
              <div className="bulk-bar" role="toolbar" aria-label="Selected notes">
                <button className="text-button" onClick={exitSelection}>Done</button>
                <span className="bulk-count">{selectedList.length} selected</span>
                <button
                  className="text-button"
                  onClick={() => setSelectedIds(selectedList.length === visibleNotes.length ? new Set() : new Set(visibleNotes.map(n => n.id)))}
                >
                  {selectedList.length === visibleNotes.length && visibleNotes.length ? 'None' : 'All'}
                </button>
                <div className="bulk-actions">
                  {view === 'trash' ? (
                    <>
                      <button className="tool-button" disabled={!selectedList.length} onClick={() => restoreNotes(selectedList)} aria-label="Restore selected" title="Restore"><RotateCcw size={16}/></button>
                      <button className="tool-button danger" disabled={!selectedList.length} onClick={() => deleteForever(selectedList)} aria-label="Delete selected permanently" title="Delete permanently"><Trash2 size={16}/></button>
                    </>
                  ) : (
                    <>
                      <button className="tool-button" disabled={!selectedList.length} onClick={() => pinNotes(selectedList, !selectedList.every(id => noteMap.get(id)?.pinned))} aria-label="Pin or unpin selected" title="Pin / unpin"><Pin size={16}/></button>
                      <button className="tool-button" disabled={!selectedList.length} onClick={event => setMenu({ kind: 'move', anchor: event.currentTarget, ids: selectedList })} aria-label="Move selected to folder" title="Move to folder"><FolderInput size={16}/></button>
                      <button className="tool-button" disabled={!selectedList.length} onClick={() => archiveNotes(selectedList, view !== 'archive')} aria-label={view === 'archive' ? 'Unarchive selected' : 'Archive selected'} title={view === 'archive' ? 'Unarchive' : 'Archive'}>{view === 'archive' ? <ArchiveRestore size={16}/> : <Archive size={16}/>}</button>
                      <button className="tool-button danger" disabled={!selectedList.length} onClick={() => trashNotesById(selectedList)} aria-label="Move selected to trash" title="Move to trash"><Trash2 size={16}/></button>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="note-list">
              {!initialLoaded ? (
                <div className="list-skeleton" aria-label="Loading notes">{[0, 1, 2, 3].map(i => <div key={i}/>)}</div>
              ) : visibleNotes.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><FileText size={22}/></div>
                  <strong>{q ? 'No matching notes' : view === 'trash' ? 'Nothing in Recently deleted' : 'Nothing here just yet'}</strong>
                  <p>{q ? 'Try another search term.' : view === 'trash' ? 'Deleted notes stay here for 30 days.' : 'Create a note and give your thoughts a home.'}</p>
                  {!q && view !== 'trash' && view !== 'archive' && (
                    <button onClick={() => createNote()}><Plus size={15}/> Write a note</button>
                  )}
                </div>
              ) : (
                visibleNotes.map((note, index) => {
                  const prev = visibleNotes[index - 1];
                  const label = showPinnedLabels && (index === 0 && note.pinned ? 'Pinned' : prev?.pinned && !note.pinned ? 'Notes' : null);
                  const isActive = activeId === note.id;
                  return (
                    <div key={note.id} data-note-id={note.id}>
                      {label && <div className="list-section-label">{label}</div>}
                      <NoteCard
                        note={note}
                        title={isActive && editingNote ? displayTitle(titleDraft) : displayTitle(note.title)}
                        preview={plainText(note.content)}
                        active={isActive}
                        checked={selectedIds.has(note.id)}
                        selecting={selecting}
                        folderName={note.folderId && view !== 'folder' ? folderNameById.get(note.folderId) ?? null : null}
                        query={q}
                        now={now}
                        inTrash={view === 'trash'}
                        draggable={finePointer && note.pinned && !note.archived && !note.deleted && !selecting && (view === 'all' || view === 'pinned' || view === 'folder' || view === 'tag')}
                        onOpen={selectNote}
                        onToggle={toggleSelected}
                        onMenu={(id, point) => setMenu({ kind: 'note', id, point })}
                        onSwipe={(id, direction) => {
                          if (view === 'trash') { if (direction === 'right') restoreNotes([id]); else deleteForever([id]); }
                          else if (direction === 'left') trashNotesById([id]);
                          else archiveNotes([id], !noteMap.get(id)?.archived);
                        }}
                        onDragStart={id => { dragNote.current = id; }}
                        onDrop={id => { if (dragNote.current) reorderPinned(dragNote.current, id); dragNote.current = null; }}
                      />
                    </div>
                  );
                })
              )}
              {hasMore && view !== 'trash' && (
                <button className="load-more" onClick={() => setLimitCount(c => c + PAGE_SIZE)}>Load older notes</button>
              )}
            </div>

            <div className="list-footer">
              <span>{visibleNotes.length} {visibleNotes.length === 1 ? 'item' : 'items'}</span>
              <span>{coarse ? 'Swipe or long-press a note for actions' : 'PRIVATE WORKSPACE'}</span>
            </div>
          </section>

          <section className="editor-panel" aria-label="Editor">
            <div className="editor-shell" hidden={!editingNote}>
              <div className="editor-toolbar">
                <div className="editor-tools">
                  <button className="icon-button mobile-back" onClick={closeEditor} aria-label="Back to notes" title="Back to notes">
                    <ArrowLeft size={19}/>
                  </button>
                  {/* Touch devices get the format bar above the keyboard instead. */}
                  {!coarse && <FormatBar editor={editor} state={format} onLink={openLinkDialog} mod={mod}/>}
                </div>

                {editingNote && (
                  <div className="editor-actions">
                    <label className="folder-select-wrap" title="Move to folder">
                      <Folder size={14}/>
                      <select
                        className="folder-select"
                        aria-label="Folder"
                        value={editingNote.folderId || ''}
                        onChange={event => updateNotes([editingNote.id], { folderId: event.target.value || null })}
                      >
                        <option value="">No folder</option>
                        {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </label>

                    <button
                      className={`tool-button ${editingNote.pinned ? 'is-active' : ''}`}
                      title={editingNote.pinned ? 'Unpin note' : 'Pin note'}
                      aria-label={editingNote.pinned ? 'Unpin note' : 'Pin note'}
                      aria-pressed={editingNote.pinned}
                      onClick={() => pinNotes([editingNote.id], !editingNote.pinned)}
                    >
                      <Pin size={16}/>
                    </button>

                    <button
                      className={`tool-button ${editingNote.archived ? 'is-active' : ''}`}
                      title={editingNote.archived ? 'Unarchive note' : 'Archive note'}
                      aria-label={editingNote.archived ? 'Unarchive note' : 'Archive note'}
                      onClick={() => archiveNotes([editingNote.id], !editingNote.archived)}
                    >
                      {editingNote.archived ? <ArchiveRestore size={16}/> : <Archive size={16}/>}
                    </button>

                    <button
                      className="tool-button export-trigger"
                      title="Export note"
                      aria-label="Export note"
                      disabled={exporting}
                      onClick={event => setMenu({ kind: 'export', anchor: event.currentTarget })}
                    >
                      <Download size={16}/>
                      <span>{exporting ? 'Exporting…' : 'Export'}</span>
                    </button>

                    <button
                      className="tool-button"
                      aria-label="More actions"
                      title="More"
                      onClick={event => setMenu({ kind: 'more', anchor: event.currentTarget })}
                    >
                      {exporting ? <span className="spinner"/> : <MoreHorizontal size={18}/>}
                    </button>
                  </div>
                )}
              </div>

              <div className="editor-content">
                {editingNote && (
                  <div className="note-date">
                    {longDate(editingNote.createdAt)}
                    {editingNote.updatedAt - editingNote.createdAt > 60_000 && <span> · Edited {relativeDate(editingNote.updatedAt, now).toLowerCase()}</span>}
                    {editingNote.archived && <span className="note-badge">Archived</span>}
                  </div>
                )}

                <input
                  ref={titleRef}
                  className="note-title-input"
                  value={titleDraft}
                  aria-label="Note title"
                  enterKeyHint="next"
                  onChange={event => {
                    setTitleDraft(event.target.value);
                    if (editingNote) scheduleSave(editingNote.id, { title: event.target.value });
                  }}
                  onKeyDown={event => {
                    if ((event.key === 'Enter' || event.key === 'ArrowDown') && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      focusEditorStart();
                    }
                  }}
                  placeholder="Untitled note"
                />

                {editingNote && (
                  <TagEditor tags={editingNote.tags} suggestions={allTags} onChange={tags => setNoteTags(editingNote.id, tags)}/>
                )}

                <div className="editor-separator"/>

                <EditorContent editor={editor}/>

                <div className="editor-bottom">
                  <span className={`editor-sync ${syncState}`}>
                    {syncState === 'offline' ? <CloudOff size={14}/> : syncState === 'synced' ? <CheckCircle2 size={14}/> : <Cloud size={14}/>}
                    {syncState === 'saving' ? 'Saving changes' : syncState === 'offline' ? 'Saved on this device — will sync when you’re back online' : syncState === 'syncing' ? 'Syncing…' : 'All changes saved'}
                  </span>
                  <span>{words} {words === 1 ? 'word' : 'words'}</span>
                </div>
              </div>
            </div>

            {!editingNote && trashNote && (
              <div className="trash-detail">
                <button className="icon-button mobile-back floating" onClick={closeEditor} aria-label="Back to notes"><ArrowLeft size={19}/></button>
                <Trash2 size={28}/>
                <h2>{displayTitle(trashNote.title)}</h2>
                <p>This note is in Recently deleted and will be removed {(() => {
                  const daysLeft = Math.max(0, Math.ceil(((trashNote.deletedAt ?? trashNote.updatedAt) + TRASH_DAYS * 86_400_000 - now) / 86_400_000));
                  return daysLeft <= 1 ? 'within a day' : `in ${daysLeft} days`;
                })()}.</p>
                <div className="trash-preview">{plainText(trashNote.content).slice(0, 600) || 'No additional text'}</div>
                <button className="primary-button" onClick={() => restoreNotes([trashNote.id])}>
                  <Check size={16}/> Restore note
                </button>
                <button className="text-button danger" onClick={() => deleteForever([trashNote.id])}>
                  Delete permanently
                </button>
              </div>
            )}

            {!editingNote && !trashNote && (
              <div className="editor-empty">
                <button className="icon-button mobile-back floating" onClick={closeEditor} aria-label="Back to notes"><ArrowLeft size={19}/></button>
                <div className="empty-art" aria-hidden="true">
                  <div className="empty-art-sheet"><div/><div/><div/></div>
                  <Sparkles className="empty-spark" size={22}/>
                </div>
                <p className="eyebrow">A MOMENT TO THINK</p>
                <h2>Your next idea<br/><em>starts here.</em></h2>
                <p>Select a note to pick up where you left off,<br/>or create something new.</p>
                <button className="primary-button" onClick={() => createNote()}>
                  <Plus size={16}/> Create a note
                </button>
                {finePointer && (
                  <div className="shortcut-hint">
                    <CommandIcon size={12}/> <kbd>{newNoteHint}</kbd> <span>to start writing</span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </section>

      {coarse && editorFocused && editingNote && (!compact || mobileEditorOpen) && (
        <div className="keyboard-bar" role="toolbar" aria-label="Formatting">
          <div className="keyboard-bar-tools">
            <button
              className={`tool-button ${format?.block === 'h2' ? 'is-active' : ''}`}
              aria-label="Heading"
              onPointerDown={event => event.preventDefault()}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              <Heading2 size={17}/>
            </button>
            <FormatBar editor={editor} state={format} onLink={openLinkDialog} mod={mod} variant="keyboard"/>
          </div>
          <button className="keyboard-done" onPointerDown={event => event.preventDefault()} onClick={() => { editor?.commands.blur(); setEditorFocused(false); }}>
            Done
          </button>
        </div>
      )}

      <input
        ref={importRef}
        type="file"
        hidden
        multiple
        accept=".md,.markdown,.txt,.html,.htm,.json,.zip,text/markdown,text/plain,text/html,application/json,application/zip"
        onChange={event => importFiles(event.target.files)}
      />

      {menu && <Menu items={menuItems(menu)} anchor={'anchor' in menu ? menu.anchor : undefined} point={'point' in menu ? menu.point : undefined} onClose={closeMenu} width={menu.kind === 'account' ? 240 : 220}/>}

      {dialog && <Dialog request={dialog} onDone={() => setDialog(null)}/>}

      {paletteOpen && (
        <CommandPalette commands={buildCommands()} notes={paletteNotes} onOpenNote={id => {
          const note = noteMap.get(id);
          if (note && view !== 'all' && !(view === 'folder' && note.folderId === folderId)) { goTo(note.archived ? 'archive' : 'all'); }
          setActiveId(id);
          openEditorLayer();
        }} onClose={() => setPaletteOpen(false)}/>
      )}

      {historyNoteId && activeNote && activeNote.id === historyNoteId && (
        <VersionHistory note={activeNote} onRestore={restoreVersion} onClose={() => setHistoryNoteId(null)}/>
      )}

      {sheet === 'shortcuts' && (
        <Sheet title="Keyboard shortcuts" onClose={() => setSheet(null)} icon={<Keyboard size={18}/>}>
          <div className="shortcut-table">
            {[
              ['New note', mod(['mod', 'alt', 'N'])],
              ['Search & commands', mod(['mod', 'K'])],
              ['Search this list', '/'],
              ['Previous / next note', '↑ / ↓'],
              ['Start typing in note', '↵'],
              ['Save now', mod(['mod', 'S'])],
              ['Toggle sidebar', mod(['mod', '\\'])],
              ['Move note to trash', mod(['mod', '⌫'])],
              ['Bold / Italic', `${mod(['mod', 'B'])} / ${mod(['mod', 'I'])}`],
              ['Strikethrough', mod(['mod', 'shift', 'S'])],
              ['Add link (in note)', mod(['mod', 'K'])],
              ['Open link', `${mod(['mod'])}-click`],
              ['Undo / Redo', `${mod(['mod', 'Z'])} / ${mod(['mod', 'shift', 'Z'])}`],
              ['Multi-select', `${mod(['mod'])}-click / ⇧-click`],
            ].map(([label, keys]) => (
              <div key={label} className="shortcut-row"><span>{label}</span><kbd>{keys}</kbd></div>
            ))}
          </div>
          <p className="modal-message small">
            Markdown shortcuts while typing: <code># </code> heading, <code>- </code> list, <code>1. </code> numbered list,
            <code>[ ] </code> checklist, <code>&gt; </code> quote, <code>```</code> code block, <code>**bold**</code>, <code>*italic*</code>, <code>~~strike~~</code>.
          </p>
        </Sheet>
      )}

      {sheet === 'install' && (
        <Sheet title="Install ded - notes" onClose={() => setSheet(null)} icon={<Smartphone size={18}/>}>
          <ol className="install-steps">
            <li>Open this page in <strong>Safari</strong>.</li>
            <li>Tap the <strong>Share</strong> button <Share size={14}/> in the toolbar.</li>
            <li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
          </ol>
          <p className="modal-message small">The app opens full-screen, works offline, and keeps you signed in.</p>
        </Sheet>
      )}

      {toast && <ToastView toast={toast} onClose={() => setToast(null)}/>}
    </main>
  );
}

/* ───────────────────────── small components ───────────────────────── */

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-dot"/>
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button className="toast-action" onClick={() => { toast.action?.run(); onClose(); }}>{toast.action.label}</button>
      )}
      <button className="toast-close" onClick={onClose} aria-label="Dismiss"><X size={14}/></button>
    </div>
  );
}

function Avatar({ user }: { user: User }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="avatar" aria-hidden="true">
      {user.photoURL && !failed
        ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
        : (user.displayName?.[0] || user.email?.[0] || 'A').toUpperCase()}
    </div>
  );
}

function NavButton({ icon, label, count, active, onClick }: {
  icon: React.ReactNode; label: string; count?: number; active: boolean; onClick: () => void;
}) {
  return (
    <button className={`nav-button ${active ? 'nav-active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-text">{label}</span>
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
