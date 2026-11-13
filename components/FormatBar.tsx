'use client';

import type { Editor } from '@tiptap/core';
import {
  Bold, CheckSquare, Code, Italic, Link2, List, ListOrdered, Quote, Redo2, SquareCode, Strikethrough, Undo2,
} from 'lucide-react';

export type FormatState = {
  bold: boolean; italic: boolean; strike: boolean; code: boolean; link: boolean;
  bullet: boolean; ordered: boolean; task: boolean; quote: boolean; codeBlock: boolean;
  block: 'p' | 'h1' | 'h2' | 'h3';
  fontSize: string;
  canUndo: boolean; canRedo: boolean;
};

export function readFormatState(editor: Editor | null): FormatState | null {
  if (!editor) return null;
  const block = editor.isActive('heading', { level: 1 }) ? 'h1'
    : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    link: editor.isActive('link'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    task: editor.isActive('taskList'),
    quote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    block,
    fontSize: (editor.getAttributes('fontSize').fontSize as string | undefined) ?? 'default',
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };
}

// Keep the editor focused (and the phone keyboard open) when tapping toolbar buttons.
const keepFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

function Tool({ label, active, disabled, onClick, children, shortcut }: {
  label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; shortcut?: string;
}) {
  return (
    <button
      type="button"
      className={`tool-button ${active ? 'is-active' : ''}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function FormatBar({ editor, state, onLink, mod, variant = 'toolbar' }: {
  editor: Editor | null;
  state: FormatState | null;
  onLink: () => void;
  mod: (keys: string[]) => string;
  variant?: 'toolbar' | 'keyboard';
}) {
  const chain = () => editor?.chain().focus();
  const s = state;
  const full = variant === 'toolbar';

  return (
    <>
      {full && <>
      <select
        className="block-select"
        title="Paragraph style"
        aria-label="Paragraph style"
        value={s?.block ?? 'p'}
        onChange={event => {
          const value = event.target.value;
          if (value === 'p') chain()?.setParagraph().run();
          else chain()?.toggleHeading({ level: Number(value[1]) as 1 | 2 | 3 }).run();
        }}
      >
        <option value="p">Body</option>
        <option value="h1">Title</option>
        <option value="h2">Heading</option>
        <option value="h3">Subheading</option>
      </select>

      <select
        className="font-size-select"
        title="Text size"
        aria-label="Text size"
        value={s?.fontSize ?? 'default'}
        onChange={event => {
          const size = event.target.value;
          if (size === 'default') chain()?.unsetMark('fontSize').run();
          else chain()?.setMark('fontSize', { fontSize: size }).run();
        }}
      >
        <option value="default">Aa</option>
        {['12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'].map(size => (
          <option key={size} value={size}>{size.replace('px', '')}</option>
        ))}
      </select>

      <span className="tool-divider"/>
      </>}

      <Tool label="Bold" shortcut={mod(['mod', 'B'])} active={s?.bold} onClick={() => chain()?.toggleBold().run()}><Bold size={16}/></Tool>
      <Tool label="Italic" shortcut={mod(['mod', 'I'])} active={s?.italic} onClick={() => chain()?.toggleItalic().run()}><Italic size={16}/></Tool>
      <Tool label="Strikethrough" shortcut={mod(['mod', 'shift', 'S'])} active={s?.strike} onClick={() => chain()?.toggleStrike().run()}><Strikethrough size={16}/></Tool>
      {full && <Tool label="Inline code" shortcut={mod(['mod', 'E'])} active={s?.code} onClick={() => chain()?.toggleCode().run()}><Code size={16}/></Tool>}
      <Tool label="Link" shortcut={mod(['mod', 'K'])} active={s?.link} onClick={onLink}><Link2 size={16}/></Tool>

      <span className="tool-divider"/>

      <Tool label="Bulleted list" active={s?.bullet} onClick={() => chain()?.toggleBulletList().run()}><List size={17}/></Tool>
      <Tool label="Numbered list" active={s?.ordered} onClick={() => chain()?.toggleOrderedList().run()}><ListOrdered size={17}/></Tool>
      <Tool label="Checklist" active={s?.task} onClick={() => chain()?.toggleTaskList().run()}><CheckSquare size={16}/></Tool>
      <Tool label="Quote" active={s?.quote} onClick={() => chain()?.toggleBlockquote().run()}><Quote size={16}/></Tool>
      <Tool label="Code block" active={s?.codeBlock} onClick={() => chain()?.toggleCodeBlock().run()}><SquareCode size={16}/></Tool>

      <span className="tool-divider"/>

      <Tool label="Undo" shortcut={mod(['mod', 'Z'])} disabled={!s?.canUndo} onClick={() => chain()?.undo().run()}><Undo2 size={16}/></Tool>
      <Tool label="Redo" shortcut={mod(['mod', 'shift', 'Z'])} disabled={!s?.canRedo} onClick={() => chain()?.redo().run()}><Redo2 size={16}/></Tool>
    </>
  );
}
