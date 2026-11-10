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
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
export type Folder = { id: string; ownerId: string; name: string; sortOrder?: number; createdAt: number };
export type View = 'all' | 'pinned' | 'recent' | 'archive' | 'trash' | 'folder';
