'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';

export type DialogRequest = {
  title: string;
  message?: ReactNode;
  icon?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the dialog shows a text field and resolves with its value. */
  input?: { initial?: string; placeholder?: string; type?: 'text' | 'url'; maxLength?: number };
  /** Extra buttons on the left (e.g. "Remove link"). They close the dialog. */
  extras?: Array<{ label: string; onClick: () => void; danger?: boolean }>;
  resolve: (value: string | boolean | null) => void;
};

/** macOS-style sheet used for confirmations and short text prompts. */
export function Dialog({ request, onDone }: { request: DialogRequest; onDone: () => void }) {
  const [value, setValue] = useState(request.input?.initial ?? '');
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const finish = (result: string | boolean | null) => {
    if (done.current) return; // guard against double submit
    done.current = true;
    request.resolve(result);
    onDone();
  };

  const canConfirm = !request.input || value.trim().length > 0;
  const confirm = () => {
    if (!canConfirm) return;
    finish(request.input ? value.trim() : true);
  };

  // Escape works even before focus has moved into the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(request.input ? null : false); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (request.input) { inputRef.current?.focus(); inputRef.current?.select(); }
      else confirmRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [request.input]);

  return (
    <div
      className="modal-backdrop"
      onPointerDown={event => { if (event.target === event.currentTarget) finish(request.input ? null : false); }}
    >
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        {request.icon && <div className={`modal-icon ${request.danger ? 'danger' : ''}`}>{request.icon}</div>}
        <h3 id="dialog-title">{request.title}</h3>
        {request.message && <div className="modal-message">{request.message}</div>}
        {request.input && (
          <input
            ref={inputRef}
            type={request.input.type ?? 'text'}
            value={value}
            maxLength={request.input.maxLength ?? 120}
            placeholder={request.input.placeholder}
            autoCapitalize={request.input.type === 'url' ? 'off' : 'sentences'}
            autoCorrect={request.input.type === 'url' ? 'off' : 'on'}
            inputMode={request.input.type === 'url' ? 'url' : 'text'}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              // Ignore Enter while an IME (Chinese, Japanese, Korean, Bangla…) is composing.
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                confirm();
              }
            }}
          />
        )}
        <div className="modal-actions">
          {request.extras?.map(extra => (
            <button
              key={extra.label}
              className={`secondary-button modal-extra ${extra.danger ? 'danger' : ''}`}
              onClick={() => { finish(null); extra.onClick(); }}
            >
              {extra.label}
            </button>
          ))}
          <button className="secondary-button" onClick={() => finish(request.input ? null : false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            className={`primary-button ${request.danger ? 'danger' : ''}`}
            disabled={!canConfirm}
            onClick={confirm}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Generic sheet (shortcuts, install instructions, version history). */
export function Sheet({ title, onClose, children, wide, icon }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; icon?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-header">
          {icon && <div className="modal-icon small">{icon}</div>}
          <h3>{title}</h3>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
