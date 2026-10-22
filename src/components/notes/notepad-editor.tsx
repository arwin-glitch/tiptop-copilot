'use client';

import * as React from 'react';
import { Bold, Heading, Italic, List, ListChecks } from 'lucide-react';
import type { RecipeView, TemplateView } from '@/lib/types/notes';
import { cn } from '@/lib/util/cn';
import { replaceRange, slashQuery, toggleLinePrefix, wrapSelection } from './helpers';

type MenuItem = { key: string; label: string; hint: string };

const COMMANDS: MenuItem[] = [
  { key: 'action', label: '/action', hint: 'Add an action item checkbox' },
  { key: 'template', label: '/template', hint: 'Pick the template for the notes' },
  { key: 'recipe', label: '/recipe', hint: 'Run a saved prompt in Chat' },
];

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The notepad (D-076): markdown headings, bullets, checkboxes, bold and
 * italic, kept word for word and treated as the details the notes must
 * include. "/" at the start of a word opens the commands: /action,
 * /template, /recipe. Saving is the page's job (debounced as you type).
 */
export function NotepadEditor({
  value,
  onChange,
  saveState,
  templates,
  recipes,
  onTemplate,
  onRecipe,
  className,
  placeholder = 'Type your own notes. Lines you write here are kept word for word.',
}: {
  value: string;
  onChange: (text: string) => void;
  saveState: SaveState;
  templates: readonly TemplateView[];
  recipes: readonly RecipeView[];
  onTemplate: (templateId: string) => void;
  onRecipe: (recipe: RecipeView) => void;
  className?: string;
  placeholder?: string;
}) {
  const area = React.useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = React.useState(0);
  const [mode, setMode] = React.useState<'commands' | 'templates' | 'recipes'>('commands');
  const [active, setActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState<number | null>(null);
  const [menuTop, setMenuTop] = React.useState(8);
  const listId = React.useId();
  const hintId = React.useId();

  const slash = slashQuery(value, caret);
  const open = slash !== null && dismissed !== slash.start;
  const items: MenuItem[] = !open
    ? []
    : mode === 'templates'
      ? templates.map((t) => ({ key: t.id, label: t.name, hint: t.purpose }))
      : mode === 'recipes'
        ? recipes.length
          ? recipes.map((r) => ({ key: r.id, label: r.name, hint: r.prompt.slice(0, 80) }))
          : [{ key: '', label: 'No recipes yet', hint: 'Add one in Notes settings' }]
        : COMMANDS.filter((c) => c.key.startsWith(slash?.query ?? ''));

  const setText = (text: string, nextCaret: number) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const removeCommand = (): { text: string; caret: number } =>
    slash ? replaceRange(value, slash.start, caret, '') : { text: value, caret };

  const choose = (item: MenuItem | undefined) => {
    if (!item || !slash) return;
    if (mode === 'commands') {
      if (item.key === 'action') {
        const lineStart = value.lastIndexOf('\n', slash.start - 1) + 1;
        const atLineStart = value.slice(lineStart, slash.start).trim() === '';
        const next = replaceRange(value, slash.start, caret, atLineStart ? '- [ ] ' : '\n- [ ] ');
        setText(next.text, next.caret);
        return;
      }
      setMode(item.key === 'template' ? 'templates' : 'recipes');
      setActive(0);
      return;
    }
    const cleared = removeCommand();
    setText(cleared.text, cleared.caret);
    setMode('commands');
    if (!item.key) return;
    if (mode === 'templates') onTemplate(item.key);
    else {
      const recipe = recipes.find((r) => r.id === item.key);
      if (recipe) onRecipe(recipe);
    }
  };

  const format = (kind: 'heading' | 'bullet' | 'check' | 'bold' | 'italic') => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const next =
      kind === 'bold'
        ? wrapSelection(value, s, e, '**')
        : kind === 'italic'
          ? wrapSelection(value, s, e, '_')
          : toggleLinePrefix(
              value,
              s,
              e,
              kind === 'heading' ? '## ' : kind === 'bullet' ? '- ' : '- [ ] ',
            );
    onChange(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.selStart, next.selEnd);
    });
  };

  const tools: { kind: Parameters<typeof format>[0]; label: string; icon: React.ReactNode }[] = [
    { kind: 'heading', label: 'Heading', icon: <Heading aria-hidden className="size-4" /> },
    { kind: 'bullet', label: 'Bullet list', icon: <List aria-hidden className="size-4" /> },
    { kind: 'check', label: 'Checkbox', icon: <ListChecks aria-hidden className="size-4" /> },
    { kind: 'bold', label: 'Bold', icon: <Bold aria-hidden className="size-4" /> },
    { kind: 'italic', label: 'Italic', icon: <Italic aria-hidden className="size-4" /> },
  ];

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-notepad="">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] pb-1.5">
        <div role="toolbar" aria-label="Formatting" className="flex gap-0.5">
          {tools.map((t) => (
            <button
              key={t.kind}
              type="button"
              onClick={() => format(t.kind)}
              aria-label={t.label}
              title={t.label}
              className="rounded p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            >
              {t.icon}
            </button>
          ))}
        </div>
        <span className="text-mini text-[var(--fg-subtle)]" aria-live="polite">
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Not saved: retrying'
                : ''}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <textarea
          ref={area}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setMenuTop(menuTopFor(e.target, e.target.value, e.target.selectionStart));
            setDismissed(null);
            if (!slashQuery(e.target.value, e.target.selectionStart)) setMode('commands');
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            setCaret(el.selectionStart);
            setMenuTop(menuTopFor(el, el.value, el.selectionStart));
          }}
          onKeyDown={(e) => {
            if (!open || items.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => (i + 1) % items.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => (i - 1 + items.length) % items.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(items[Math.min(active, items.length - 1)]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(slash?.start ?? null);
              setMode('commands');
            }
          }}
          aria-label="Your notes"
          aria-describedby={hintId}
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
          placeholder={placeholder}
          spellCheck
          className="h-full min-h-56 w-full resize-none bg-transparent py-3 font-mono text-sm leading-relaxed text-[var(--fg)] outline-none placeholder:font-sans placeholder:text-[var(--fg-subtle)]"
        />
        <p id={hintId} className="sr-only">
          Markdown works. Type a slash for commands: action, template, recipe.
        </p>
        {open && items.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={
              mode === 'commands' ? 'Commands' : mode === 'templates' ? 'Templates' : 'Recipes'
            }
            style={{ top: menuTop }}
            className="shadow-overlay absolute left-2 z-10 max-h-60 w-[min(20rem,calc(100%-1rem))] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
          >
            {items.map((item, i) => (
              <li
                key={item.key || item.label}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
                className={cn(
                  'cursor-pointer rounded px-2 py-1.5 text-sm',
                  i === active ? 'bg-[var(--bg-hover)]' : '',
                )}
              >
                <span className="font-medium">{item.label}</span>
                <span className="block truncate text-xs text-[var(--fg-muted)]">{item.hint}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Just under the caret's line (the notepad's own line height), kept inside the box. */
function menuTopFor(el: HTMLTextAreaElement, text: string, caret: number): number {
  const line = text.slice(0, caret).split(/\n/).length;
  const style = getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight) || 22;
  const padTop = Number.parseFloat(style.paddingTop) || 12;
  const top = padTop + line * lineHeight - el.scrollTop + 4;
  return Math.max(8, Math.min(top, el.clientHeight - 140));
}
