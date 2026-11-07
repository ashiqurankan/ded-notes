export type Note = {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  folderId: string | null;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
export type Folder = { id: string; ownerId: string; name: string; createdAt: number };
export type View = 'all' | 'pinned' | 'recent' | 'archive' | 'trash' | 'folder';
