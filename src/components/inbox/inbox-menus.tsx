'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, Inbox as InboxIcon, OctagonAlert, Tag, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MailLabel } from '@/lib/email/inbox-actions';
import { cn } from '@/lib/util/cn';

export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-[var(--fg)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none disabled:cursor-default disabled:opacity-50';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** A rule above this item. */
  divider?: boolean;
}

/** Arrow keys move between a menu's items, as in a native menu. */
function onMenuKey(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  next?.focus();
  e.preventDefault();
}

function Items({ items, close }: { items: readonly MenuItem[]; close: () => void }) {
  return (
    <div role="menu" onKeyDown={onMenuKey} className="space-y-px">
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.divider ? <div role="separator" className="my-1 h-px bg-[var(--border)]" /> : null}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={MENU_ITEM}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.checked !== undefined ? (
              <Check className={cn('size-4', !item.checked && 'invisible')} aria-hidden />
            ) : item.icon ? (
              <item.icon className="size-4 text-[var(--fg-muted)]" aria-hidden />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

/** A button that opens a short menu (Gmail's select dropdown, the ⋮ menu). */
export function MenuButton({
  label,
  items,
  children,
  open,
  onOpenChange,
  align = 'start',
  className,
}: {
  label: string;
  items: readonly MenuItem[];
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  const [own, setOwn] = React.useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} aria-label={label} className={cn('w-56 p-1', className)}>
        <Items items={items} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Gmail's "Move to": the inbox, the person's own labels, Spam and Trash.
 * Picking one calls `onMove`; nothing moves until then. `current` is the
 * folder the thread is in now, left out of the choices.
 */
export function MoveMenu({
  labels,
  current,
  onMove,
  open,
  onOpenChange,
  children,
}: {
  labels: readonly MailLabel[];
  current: string | null;
  onMove: (to: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [own, setOwn] = React.useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [filter, setFilter] = React.useState('');
  const q = filter.trim().toLowerCase();
  const items: MenuItem[] = [
    { id: 'INBOX', label: 'Inbox', icon: InboxIcon, onSelect: () => onMove('INBOX') },
    ...labels.map((l) => ({ id: l.id, label: l.name, icon: Tag, onSelect: () => onMove(l.id) })),
    {
      id: 'SPAM',
      label: 'Spam',
      icon: OctagonAlert,
      divider: true,
      onSelect: () => onMove('SPAM'),
    },
    { id: 'TRASH', label: 'Trash', icon: Trash2, onSelect: () => onMove('TRASH') },
  ].filter((i) => i.id !== current && (!q || i.label.toLowerCase().includes(q)));
  return (
    <Popover
      open={isOpen}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter('');
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" aria-label="Move to" className="w-60 p-1">
        <p className="px-2 pt-1 text-xs font-medium text-[var(--fg-muted)]">Move to:</p>
        <label className="sr-only" htmlFor="move-filter">
          Find a folder
        </label>
        <input
          id="move-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a folder"
          className="mx-1 my-1 h-8 w-[calc(100%-0.5rem)] rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
        />
        <Items items={items} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The row's right-click menu, drawn where the pointer is. Escape, a click
 * elsewhere or a scroll closes it; arrow keys move between its items.
 */
export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState(at);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  React.useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Conversation actions"
      style={{ left: pos.x, top: pos.y }}
      className="shadow-overlay fixed z-[var(--z-overlay)] w-60 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
    >
      <Items items={items} close={onClose} />
    </div>,
    document.body,
  );
}
