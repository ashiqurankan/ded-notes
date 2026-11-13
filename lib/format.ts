const textCache = new Map<string, string>();

/**
 * Plain text for previews/search. Uses DOMParser (inert document: no scripts run,
 * no images load) and caches results so list renders and keystrokes stay cheap.
 */
export function plainText(html: string | undefined | null): string {
  if (!html) return '';
  const hit = textCache.get(html);
  if (hit !== undefined) return hit;

  // Put a space between blocks so "line one" + "line two" don't merge.
  const spaced = html
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|div)>/gi, '$& ')
    .replace(/<br\s*\/?>/gi, ' ');

  let text: string;
  if (typeof DOMParser === 'undefined') {
    text = spaced.replace(/<[^>]*>/g, ' ');
  } else {
    text = new DOMParser().parseFromString(spaced, 'text/html').body.textContent || '';
  }
  text = text.replace(/\s+/g, ' ').trim();

  if (textCache.size > 3000) textCache.clear();
  textCache.set(html, text);
  return text;
}

export function wordCount(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function relativeDate(timestamp: number, now = Date.now()) {
  const delta = now - timestamp;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 2 * 86_400_000) return 'Yesterday';
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function longDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

export function dateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** A short excerpt of `text`, centred on the first match of `query` when there is one. */
export function snippet(text: string, query: string, length = 150) {
  if (!query) return text.slice(0, length);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, length);
  const start = Math.max(0, index - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + length);
}

/** Strip anything executable from HTML before injecting it into the page (exports/imports). */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,button,textarea,select,svg,math,base')
    .forEach(el => el.remove());
  doc.querySelectorAll('input').forEach(input => {
    if (input.getAttribute('type') !== 'checkbox') input.remove();
  });
  doc.body.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && (value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html'))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

export function normalizeTag(raw: string) {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 40);
}

export function safeFileName(name: string, fallback = 'note') {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
}
