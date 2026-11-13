'use client';

import { useState } from 'react';
import { Hash, X } from 'lucide-react';
import { normalizeTag } from '@/lib/format';

export function TagEditor({ tags, suggestions, onChange }: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map(normalizeTag).filter(Boolean);
    const next = Array.from(new Set([...tags, ...parts])).slice(0, 30);
    if (next.length !== tags.length) onChange(next);
    setDraft('');
  };

  return (
    <div className="tag-editor">
      <Hash size={13} aria-hidden="true"/>
      {tags.map(tag => (
        <span key={tag} className="tag-chip">
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter(t => t !== tag))}>
            <X size={11}/>
          </button>
        </span>
      ))}
      <input
        value={draft}
        list="ded-tag-suggestions"
        placeholder={tags.length ? 'Add tag' : 'Add tags'}
        aria-label="Add tag"
        enterKeyHint="done"
        autoCapitalize="off"
        onChange={event => {
          const value = event.target.value;
          if (/[,\n]/.test(value)) add(value); else setDraft(value);
        }}
        onBlur={() => draft.trim() && add(draft)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((event.key === 'Enter' || event.key === 'Tab') && draft.trim()) { event.preventDefault(); add(draft); }
          else if (event.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
      />
      <datalist id="ded-tag-suggestions">
        {suggestions.filter(s => !tags.includes(s)).map(s => <option key={s} value={s}/>)}
      </datalist>
    </div>
  );
}
