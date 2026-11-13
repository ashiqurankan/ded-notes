// Browser/platform helpers. Only call these on the client (after mount).

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

export function isApple() {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(ua());
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(ua()) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid() {
  return /Android/i.test(ua());
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: window-controls-overlay)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Embedded browsers (Instagram, Facebook, LinkedIn, …) where Google blocks sign-in. */
export function isInAppBrowser() {
  const agent = ua();
  return /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|\bLine\/|Twitter|MicroMessenger|TikTok|musical_ly|Snapchat|Pinterest|GSA\//i.test(agent)
    || (/Android/i.test(agent) && /; wv\)/.test(agent));
}

export function isCoarsePointer() {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/** Shortcut label: "⌥⌘N" on Apple devices, "Ctrl+Alt+N" elsewhere. */
export function shortcutLabel(keys: Array<'mod' | 'alt' | 'shift' | string>) {
  const apple = isApple();
  const map: Record<string, string> = apple
    ? { mod: '⌘', alt: '⌥', shift: '⇧' }
    : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  const parts = keys.map(k => map[k] ?? k.toUpperCase());
  if (apple) {
    // macOS order: ⌥ ⇧ ⌘ then key
    const order = ['⌥', '⇧', '⌘'];
    const mods = parts.filter(p => order.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...mods, ...parts.filter(p => !order.includes(p))].join('');
  }
  return parts.join('+');
}

export function isModKey(event: KeyboardEvent | React.KeyboardEvent) {
  return isApple() ? event.metaKey : event.ctrlKey;
}
