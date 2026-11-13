'use client';

import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string; keepOpen?: boolean }
  | { divider: true }
  | { heading: string };

/**
 * macOS-style popover menu rendered in a portal, so it is never clipped by
 * scrolling toolbars. Closes on outside tap, Escape, resize or selection, and
 * is keyboard navigable.
 */
export function Menu({ items, anchor, point, onClose, width = 210, label }: {
  items: MenuItem[];
  anchor?: HTMLElement | null;
  point?: { x: number; y: number };
  onClose: () => void;
  width?: number;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const { offsetWidth: w, offsetHeight: h } = el;
    let left: number;
    let top: number;
    if (point) {
      left = point.x;
      top = point.y;
    } else if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = r.right - w;
      top = r.bottom + 6;
      if (left < 8) left = r.left;
      if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    } else {
      left = (vw - w) / 2;
      top = (vh - h) / 2;
    }
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - h - 8));
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor, point]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); anchor?.focus(); }
    };
    const onResize = () => onClose();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      className="popover-menu"
      role="menu"
      aria-label={label}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map((item, index) => {
        if ('divider' in item) return <div key={index} className="menu-divider" role="separator"/>;
        if ('heading' in item) return <div key={index} className="menu-heading">{item.heading}</div>;
        return (
          <button
            key={index}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              if (!item.keepOpen) onClose();
              item.onSelect();
            }}
          >
            <span className="menu-icon">{item.checked ? <Check size={15}/> : item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
