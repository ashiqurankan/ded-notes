export type Note = {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  folderId: string | null;
  pinned: boolean;
  pinnedOrder?: number;
  archived: boolean;
  deleted: boolean;
  /** When the note was moved to Recently deleted (ms). Older notes fall back to updatedAt. */
  deletedAt?: number | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Random per-browser id of the device that last wrote the note (used for conflict detection). */
  deviceId?: string;
  /** When the last automatic version snapshot was taken (ms). */
  versionedAt?: number;
};

export type Folder = { id: string; ownerId: string; name: string; sortOrder?: number; createdAt: number };

export type NoteVersion = {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  /** When this snapshot was stored. */
  savedAt: number;
  /** When the captured content was last edited. */
  noteUpdatedAt: number;
  reason: 'auto' | 'conflict' | 'restore';
};

export type View = 'all' | 'pinned' | 'recent' | 'archive' | 'trash' | 'folder' | 'tag';
export type SortMode = 'updated' | 'created' | 'title';
export type ThemePref = 'system' | 'light' | 'dark';
