import MarkdownIt from 'markdown-it';
import { sanitizeHtml } from './format';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

/** Markdown → HTML that Tiptap understands (including `- [ ]` checklists). */
export function markdownToHtml(source: string): string {
  const html = md.render(source);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll('li').forEach(li => {
    const holder = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
    const first = holder.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) return;
    const match = /^\[( |x|X)\]\s?/.exec(first.textContent || '');
    if (!match) return;
    first.textContent = (first.textContent || '').slice(match[0].length);
    li.setAttribute('data-type', 'taskItem');
    li.setAttribute('data-checked', match[1].trim() ? 'true' : 'false');
    li.parentElement?.setAttribute('data-type', 'taskList');
  });

  return sanitizeHtml(doc.body.innerHTML);
}

/** Tiptap HTML → Markdown (for backups and readable version previews). */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return blocks(doc.body, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function wrap(inner: string, marker: string) {
  if (!inner.trim()) return inner;
  const lead = /^\s*/.exec(inner)?.[0] ?? '';
  const trail = /\s*$/.exec(inner)?.[0] ?? '';
  return `${lead}${marker}${inner.trim()}${marker}${trail}`;
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/([*_`\\])/g, '\\$1');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const inner = () => Array.from(el.childNodes).map(inline).join('');
  switch (el.tagName) {
    case 'STRONG': case 'B': return wrap(inner(), '**');
    case 'EM': case 'I': return wrap(inner(), '*');
    case 'S': case 'DEL': case 'STRIKE': return wrap(inner(), '~~');
    case 'CODE': return '`' + (el.textContent || '') + '`';
    case 'BR': return '  \n';
    case 'A': {
      const href = el.getAttribute('href') || '';
      const text = inner();
      return href ? `[${text || href}](${href})` : text;
    }
    case 'IMG': return `![${el.getAttribute('alt') || ''}](${el.getAttribute('src') || ''})`;
    case 'INPUT': case 'LABEL': return '';
    default: return inner();
  }
}

function list(el: Element, indent: string): string {
  const ordered = el.tagName === 'OL';
  const taskList = el.getAttribute('data-type') === 'taskList';
  let out = '';
  Array.from(el.children).forEach((li, index) => {
    if (li.tagName !== 'LI') return;
    const task = taskList || li.getAttribute('data-type') === 'taskItem';
    const marker = task
      ? `- [${li.getAttribute('data-checked') === 'true' ? 'x' : ' '}] `
      : ordered ? `${index + 1}. ` : '- ';
    const childIndent = indent + ' '.repeat(task ? 2 : marker.length);
    const textParts: string[] = [];
    let nested = '';
    const visit = (parent: Element) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const c = child as Element;
          if (c.tagName === 'LABEL') continue;
          if (c.tagName === 'UL' || c.tagName === 'OL') { nested += list(c, childIndent); continue; }
          if (c.tagName === 'DIV') { visit(c); continue; }
          if (c.tagName === 'P') { textParts.push(inline(c).trim()); continue; }
        }
        const text = inline(child);
        if (text.trim()) textParts.push(text.trim());
      }
    };
    visit(li);
    out += `${indent}${marker}${textParts.join('\n' + childIndent)}\n${nested}`;
  });
  return out;
}

function blocks(el: Element, indent: string): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent || '').trim()) out += inline(node) + '\n\n';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) out += `${'#'.repeat(Number(tag[1]))} ${inline(child).trim()}\n\n`;
    else if (tag === 'P') out += inline(child).trim() + '\n\n';
    else if (tag === 'UL' || tag === 'OL') out += list(child, indent) + '\n';
    else if (tag === 'BLOCKQUOTE') out += blocks(child, '').trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    else if (tag === 'PRE') out += '```\n' + (child.textContent || '').replace(/\n$/, '') + '\n```\n\n';
    else if (tag === 'HR') out += '---\n\n';
    else if (tag === 'IMG') out += inline(child) + '\n\n';
    else out += blocks(child, indent);
  }
  return out;
}

/** Very small YAML-ish front matter reader for our own exports (and most other apps'). */
export function splitFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
  }
  return { meta, body: source.slice(match[0].length) };
}
