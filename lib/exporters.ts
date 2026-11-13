import type { Folder, Note } from './types';
import { longDate, safeFileName, sanitizeHtml } from './format';
import { htmlToMarkdown, markdownToHtml, splitFrontMatter } from './markdown';

export type ExportFormat = 'pdf' | 'pages' | 'long';

const PAGE_W = 794;   // A4 width at 96dpi
const PAGE_H = 1123;  // A4 height at 96dpi
const MARGIN_Y = 64;
const MARGIN_X = 72;
// iOS Safari refuses canvases above ~16.7M pixels; stay well below.
const MAX_CANVAS_AREA = 14_000_000;

type Colors = { background: string; text: string; body: string; muted: string; line: string; accent: string; quote: string; code: string };

const LIGHT: Colors = { background: '#ffffff', text: '#252820', body: '#30342d', muted: '#6e7368', line: '#e6e8e2', accent: '#5b6e55', quote: '#5d6458', code: '#f3f4f1' };
const DARK: Colors = { background: '#1e211d', text: '#eceee8', body: '#dce2d6', muted: '#a3aa98', line: '#394236', accent: '#a3b69a', quote: '#bac8b1', code: '#252b23' };

function buildRoot(title: string, html: string, createdAt: number, c: Colors, paged: boolean) {
  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed', 'left:-100000px', 'top:0', `width:${PAGE_W}px`, 'box-sizing:border-box',
    paged ? `padding:0 ${MARGIN_X}px` : `padding:${MARGIN_Y}px ${MARGIN_X}px`,
    `background:${c.background}`, `color:${c.text}`,
    'font-family:var(--font-sans),Arial,Helvetica,sans-serif', 'font-size:15px', 'line-height:1.8',
  ].join(';');
  root.innerHTML = `
    <div style="font-size:12px;color:${c.muted};margin-bottom:22px">${longDate(createdAt)}</div>
    <h1 style="font-family:var(--font-display),Arial,sans-serif;font-size:34px;line-height:1.2;letter-spacing:-1px;color:${c.text};margin:0 0 24px;font-weight:700;overflow-wrap:anywhere"></h1>
    <div style="height:1px;background:${c.line};margin:0 0 26px"></div>
    <article class="ded-export-content">${sanitizeHtml(html)}</article>
    <style>
      .ded-export-content{font-size:15px;line-height:1.8;color:${c.body};overflow-wrap:anywhere}
      .ded-export-content p{margin:0 0 16px}
      .ded-export-content h1,.ded-export-content h2,.ded-export-content h3{font-family:var(--font-display),Arial,sans-serif;line-height:1.3;color:${c.text};margin:24px 0 12px}
      .ded-export-content h1{font-size:28px}.ded-export-content h2{font-size:23px}.ded-export-content h3{font-size:19px}
      .ded-export-content ul,.ded-export-content ol{padding-left:26px;margin:10px 0 18px}
      .ded-export-content li{padding-left:4px;margin:4px 0}
      .ded-export-content li p{margin:0}
      .ded-export-content a{color:${c.accent};text-decoration:underline}
      .ded-export-content blockquote{border-left:3px solid ${c.accent};margin:18px 0;padding:4px 0 4px 18px;color:${c.quote}}
      .ded-export-content ul[data-type="taskList"]{list-style:none;padding:0}
      .ded-export-content ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:9px}
      .ded-export-content ul[data-type="taskList"] li>div{flex:1}
      .ded-export-content input[type="checkbox"]{margin-top:8px;accent-color:${c.accent}}
      .ded-export-content img{max-width:100%;height:auto}
      .ded-export-content pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${c.code};padding:14px;border-radius:8px}
      .ded-export-content code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
      .ded-export-content hr{border:0;border-top:1px solid ${c.line};margin:22px 0}
    </style>`;
  const heading = root.querySelector('h1');
  if (heading) heading.textContent = title || 'Untitled note';
  return root;
}

async function waitForAssets(root: HTMLElement) {
  await Promise.all(Array.from(root.querySelectorAll('img')).map(img => img.complete
    ? Promise.resolve()
    : new Promise<void>(resolve => { img.onload = () => resolve(); img.onerror = () => resolve(); })));
  if (document.fonts?.ready) await document.fonts.ready;
}

/** Y positions (relative to root) where a page may end without cutting a line of text in half. */
function breakPoints(root: HTMLElement): number[] {
  const top = root.getBoundingClientRect().top;
  const points = new Set<number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) points.add(Math.ceil(rect.bottom - top + 3));
  }
  root.querySelectorAll('p,li,h1,h2,h3,blockquote,pre,hr,img').forEach(el => {
    points.add(Math.ceil(el.getBoundingClientRect().bottom - top + 2));
  });
  return Array.from(points).sort((a, b) => a - b);
}

function paginate(totalHeight: number, breaks: number[]) {
  const usable = PAGE_H - MARGIN_Y * 2;
  const slices: Array<[number, number]> = [];
  let start = 0;
  while (start < totalHeight - 1) {
    const limit = start + usable;
    if (limit >= totalHeight) { slices.push([start, totalHeight]); break; }
    let end = 0;
    for (const b of breaks) {
      if (b > limit) break;
      if (b > start + usable * 0.4) end = b;
    }
    if (!end) end = limit;
    slices.push([start, end]);
    start = end;
  }
  return slices.length ? slices : [[0, Math.max(1, totalHeight)] as [number, number]];
}

export async function exportNoteFile(options: {
  title: string; html: string; createdAt: number; format: ExportFormat; dark: boolean;
}): Promise<{ blob: Blob; filename: string }> {
  const { title, html, createdAt, format, dark } = options;
  const colors = dark ? DARK : LIGHT;
  const name = safeFileName(title, 'ded-notes');
  const [{ default: html2canvas }] = await Promise.all([import('html2canvas')]);

  const root = buildRoot(title, html, createdAt, colors, format !== 'long');
  document.body.appendChild(root);
  const cleanup: HTMLElement[] = [root];

  try {
    await waitForAssets(root);

    if (format === 'long') {
      const height = root.scrollHeight;
      const scale = Math.max(0.5, Math.min(2, Math.sqrt(MAX_CANVAS_AREA / (PAGE_W * height))));
      const canvas = await html2canvas(root, { backgroundColor: colors.background, scale, useCORS: true, logging: false, windowWidth: PAGE_W });
      return { blob: await canvasToBlob(canvas, 'image/png'), filename: `${name}-long.png` };
    }

    const slices = paginate(root.scrollHeight, breakPoints(root));
    const pages: HTMLCanvasElement[] = [];
    for (let i = 0; i < slices.length; i++) {
      const [start, end] = slices[i];
      const page = document.createElement('div');
      page.style.cssText = `position:fixed;left:-100000px;top:0;width:${PAGE_W}px;height:${PAGE_H}px;overflow:hidden;background:${colors.background}`;
      const clip = document.createElement('div');
      clip.style.cssText = `position:absolute;left:0;top:${MARGIN_Y}px;width:${PAGE_W}px;height:${end - start}px;overflow:hidden`;
      const clone = root.cloneNode(true) as HTMLDivElement;
      clone.style.position = 'absolute';
      clone.style.left = '0';
      clone.style.top = `${-start}px`;
      clip.appendChild(clone);
      const footer = document.createElement('div');
      footer.style.cssText = `position:absolute;left:${MARGIN_X}px;right:${MARGIN_X}px;bottom:26px;display:flex;justify-content:space-between;font:11px var(--font-sans),Arial,sans-serif;color:${colors.muted}`;
      const left = document.createElement('span');
      left.textContent = title || 'Untitled note';
      const right = document.createElement('span');
      right.textContent = `${i + 1} / ${slices.length}`;
      footer.append(left, right);
      page.append(clip, footer);
      document.body.appendChild(page);
      cleanup.push(page);
      pages.push(await html2canvas(page, { backgroundColor: colors.background, scale: 2, useCORS: true, logging: false, windowWidth: PAGE_W }));
      page.remove();
    }

    if (format === 'pages') {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (let i = 0; i < pages.length; i++) {
        zip.file(`${name}-page-${String(i + 1).padStart(2, '0')}.png`, await canvasToBlob(pages[i], 'image/png'));
      }
      return { blob: await zip.generateAsync({ type: 'blob' }), filename: `${name}-pages.zip` };
    }

    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    pages.forEach((canvas, i) => {
      if (i > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    });
    pdf.setProperties({ title: title || 'Untitled note' });
    return { blob: pdf.output('blob'), filename: `${name}.pdf` };
  } finally {
    cleanup.forEach(el => el.remove());
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not create the image. The note may be too long for this device.'))), type));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Share sheet on phones/tablets (works in iOS home-screen apps where downloads don't),
 * plain download elsewhere. Must be called from a tap/click handler.
 */
export async function deliverFile(blob: Blob, filename: string, preferShare: boolean): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (preferShare && typeof File !== 'undefined') {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      }
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

/* ───────────────────────── Backups ───────────────────────── */

export type ImportedNote = {
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  folderName: string | null;
  createdAt: number;
  updatedAt: number;
};

export function buildJsonBackup(notes: Note[], folders: Folder[]) {
  const data = {
    app: 'ded-notes',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: folders.map(f => ({ id: f.id, name: f.name, sortOrder: f.sortOrder ?? null })),
    notes: notes.filter(n => !n.deleted).map(n => ({
      title: n.title, content: n.content, tags: n.tags, pinned: n.pinned, archived: n.archived,
      folderId: n.folderId, createdAt: n.createdAt, updatedAt: n.updatedAt,
    })),
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

export async function buildMarkdownZip(notes: Note[], folders: Folder[]) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folderName = new Map(folders.map(f => [f.id, safeFileName(f.name, 'Folder')]));
  const used = new Set<string>();
  for (const note of notes) {
    if (note.deleted) continue;
    const dir = note.archived ? 'Archive/' : note.folderId && folderName.has(note.folderId) ? `${folderName.get(note.folderId)}/` : '';
    const base = safeFileName(note.title || 'Untitled note');
    let path = `${dir}${base}.md`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${dir}${base} ${n}.md`;
    used.add(path.toLowerCase());
    const front = [
      '---',
      `title: "${(note.title || 'Untitled note').replace(/"/g, '\\"')}"`,
      `created: ${new Date(note.createdAt).toISOString()}`,
      `updated: ${new Date(note.updatedAt).toISOString()}`,
      note.tags.length ? `tags: [${note.tags.join(', ')}]` : null,
      note.pinned ? 'pinned: true' : null,
      note.archived ? 'archived: true' : null,
      '---',
      '',
    ].filter(line => line !== null).join('\n');
    zip.file(path, `${front}\n${htmlToMarkdown(note.content)}`, { date: new Date(note.updatedAt) });
  }
  return zip.generateAsync({ type: 'blob' });
}

const TEXT_EXT = /\.(md|markdown|txt|html?)$/i;

function noteFromText(fileName: string, text: string, folderName: string | null, lastModified: number): ImportedNote {
  const baseName = fileName.replace(/^.*\//, '').replace(TEXT_EXT, '');
  if (/\.html?$/i.test(fileName)) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || baseName;
    return { title, content: sanitizeHtml(doc.body.innerHTML), tags: [], pinned: false, archived: false, folderName, createdAt: lastModified, updatedAt: lastModified };
  }
  const { meta, body } = splitFrontMatter(text);
  let markdown = body;
  let title = meta.title || '';
  if (!title) {
    const heading = /^#\s+(.+)\n?/.exec(markdown.trimStart());
    if (heading) { title = heading[1].trim(); markdown = markdown.trimStart().slice(heading[0].length); }
  }
  const content = /\.txt$/i.test(fileName)
    ? markdown.split(/\r?\n/).map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')
    : markdownToHtml(markdown);
  const tags = (meta.tags || '').replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean);
  const parseDate = (value?: string) => { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : lastModified; };
  return {
    title: title || baseName,
    content,
    tags,
    pinned: meta.pinned === 'true',
    archived: meta.archived === 'true',
    folderName,
    createdAt: parseDate(meta.created),
    updatedAt: parseDate(meta.updated),
  };
}

function notesFromJson(text: string): ImportedNote[] {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.notes)) throw new Error('This JSON file is not a ded - notes backup.');
  const folderNames = new Map<string, string>((data.folders || []).map((f: { id: string; name: string }) => [f.id, f.name]));
  return data.notes.map((n: Record<string, unknown>) => ({
    title: String(n.title ?? ''),
    content: sanitizeHtml(String(n.content ?? '')),
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    pinned: Boolean(n.pinned),
    archived: Boolean(n.archived),
    folderName: typeof n.folderId === 'string' ? folderNames.get(n.folderId) ?? null : null,
    createdAt: Number(n.createdAt) || Date.now(),
    updatedAt: Number(n.updatedAt) || Date.now(),
  }));
}

export async function parseImportFiles(files: File[]): Promise<ImportedNote[]> {
  const out: ImportedNote[] = [];
  for (const file of files) {
    if (/\.json$/i.test(file.name)) {
      out.push(...notesFromJson(await file.text()));
    } else if (/\.zip$/i.test(file.name)) {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || entry.name.startsWith('__MACOSX/') || /(^|\/)\./.test(entry.name)) continue;
        if (/\.json$/i.test(entry.name)) { out.push(...notesFromJson(await entry.async('string'))); continue; }
        if (!TEXT_EXT.test(entry.name)) continue;
        const parts = entry.name.split('/');
        const folder = parts.length > 1 ? parts[parts.length - 2] : null;
        const note = noteFromText(entry.name, await entry.async('string'), folder === 'Archive' ? null : folder, entry.date?.getTime() || Date.now());
        if (folder === 'Archive') note.archived = true;
        out.push(note);
      }
    } else if (TEXT_EXT.test(file.name)) {
      out.push(noteFromText(file.name, await file.text(), null, file.lastModified || Date.now()));
    }
  }
  return out;
}
