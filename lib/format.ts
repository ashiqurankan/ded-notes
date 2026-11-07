export function relativeDate(timestamp: number) {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function plainText(html: string) {
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, ' ').trim();
  const el = document.createElement('div'); el.innerHTML = html; return el.textContent || '';
}
