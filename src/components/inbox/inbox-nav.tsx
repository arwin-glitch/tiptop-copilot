'use client';

import * as React from 'react';
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  File,
  Inbox as InboxIcon,
  Mails,
  OctagonAlert,
  PenSquare,
  Plus,
  Send,
  Star,
  Tag,
  Trash2,
  Bookmark,
  type LucideIcon,
} from 'lucide-react';
import { useStoredChoice } from '@/components/inbox/use-stored';
import type { MailLabel } from '@/lib/email/inbox-actions';
import { ancestorPaths, labelTree, type LabelNode } from '@/lib/email/label-tree';
import type { FolderId, SystemFolder } from '@/lib/email/inbox-folders';
import type { InboxNav as NavCounts } from '@/lib/services/inbox-live';
import { cn } from '@/lib/util/cn';

/** Gmail's left-hand folders, in its order; the ones after Drafts sit under "More". */
export const NAV_FOLDERS: { id: SystemFolder; label: string; icon: LucideIcon; more?: boolean }[] =
  [
    { id: 'inbox', label: 'Inbox', icon: InboxIcon },
    { id: 'starred', label: 'Starred', icon: Star },
    { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
    { id: 'important', label: 'Important', icon: Bookmark },
    { id: 'sent', label: 'Sent', icon: Send },
    { id: 'scheduled', label: 'Scheduled', icon: Clock },
    { id: 'drafts', label: 'Drafts', icon: File },
    { id: 'all', label: 'All Mail', icon: Mails, more: true },
    { id: 'spam', label: 'Spam', icon: OctagonAlert, more: true },
    { id: 'trash', label: 'Trash', icon: Trash2, more: true },
  ];

const MORE_KEY = 'kraken.inbox.navMore';

/** The number Gmail shows beside a folder: unread for Inbox and Spam, a count for Drafts and Scheduled. */
function countFor(id: SystemFolder, nav: NavCounts | undefined): number | null {
  if (!nav) return null;
  switch (id) {
    case 'inbox':
      return nav.inboxUnread;
    case 'drafts':
      return nav.drafts;
    case 'spam':
      return nav.spamUnread;
    case 'scheduled':
      return nav.scheduled;
    default:
      return null;
  }
}

/**
 * Gmail's left nav in Kraken's colours: Compose, the folders with their
 * counts, "More" for the rarely used ones (remembered per browser), and the
 * person's own labels, with "+" to make a new one.
 */
export function InboxNav({
  folder,
  searched,
  nav,
  labels,
  onCompose,
  onFolder,
  onCreateLabel,
  canCreateLabel,
  className,
}: {
  folder: FolderId;
  /** A search is showing: no folder is current. */
  searched: boolean;
  nav: NavCounts | undefined;
  labels: readonly MailLabel[];
  onCompose: () => void;
  onFolder: (folder: FolderId) => void;
  onCreateLabel: () => void;
  canCreateLabel: boolean;
  className?: string;
}) {
  const [moreChoice, setMoreChoice] = useStoredChoice<'0' | '1'>(
    MORE_KEY,
    (v) => (v === '1' ? '1' : '0'),
    '0',
  );
  const more = moreChoice === '1';
  const toggleMore = () => setMoreChoice(more ? '0' : '1');
  // The folder on screen stays in view even when it sits under "More".
  const showMore = more || NAV_FOLDERS.some((f) => f.more && f.id === folder);

  return (
    <nav aria-label="Mail folders" data-tour="inbox-tabs" className={cn('min-w-0', className)}>
      <button
        type="button"
        onClick={onCompose}
        data-tour="inbox-compose"
        className="shadow-raised mb-3 inline-flex h-14 items-center gap-3 rounded-2xl bg-[var(--accent-soft)] px-5 text-sm font-semibold text-[var(--accent)] transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
      >
        <PenSquare className="size-5" aria-hidden /> Compose
      </button>
      <ul className="space-y-px">
        {NAV_FOLDERS.filter((f) => !f.more || showMore).map((f) => {
          const active = !searched && folder === f.id;
          const count = countFor(f.id, nav);
          const strong = (f.id === 'inbox' || f.id === 'spam') && (count ?? 0) > 0;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onFolder(f.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-8 w-full items-center gap-3 rounded-r-full pr-3 pl-4 text-left text-sm',
                  active
                    ? 'bg-[var(--nav-active)] font-semibold text-[var(--fg)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
                  strong && 'font-semibold text-[var(--fg)]',
                )}
              >
                <f.icon
                  className={cn('size-4 shrink-0', active && 'text-[var(--accent)]')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                {count ? (
                  <span className="text-xs tabular-nums">
                    <span className="sr-only">, </span>
                    {count.toLocaleString('en-US')}
                    <span className="sr-only">
                      {f.id === 'inbox' || f.id === 'spam' ? ' unread' : ''}
                    </span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={toggleMore}
            aria-expanded={showMore}
            className="flex h-8 w-full items-center gap-3 rounded-r-full pr-3 pl-4 text-left text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          >
            {showMore ? (
              <ChevronUp className="size-4" aria-hidden />
            ) : (
              <ChevronDown className="size-4" aria-hidden />
            )}
            {showMore ? 'Less' : 'More'}
          </button>
        </li>
      </ul>
      <div className="mt-4 flex items-center justify-between pr-2 pl-4">
        <h2 className="text-sm font-semibold text-[var(--fg)]">Labels</h2>
        {canCreateLabel ? (
          <button
            type="button"
            onClick={onCreateLabel}
            aria-label="Create new label"
            title="Create new label"
            className="rounded-full p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {labels.length === 0 ? (
        <p className="mt-1 pl-4 text-xs text-[var(--fg-subtle)]">No labels yet.</p>
      ) : (
        <LabelTreeList
          labels={labels}
          folder={folder}
          searched={searched}
          unread={nav?.labelUnread}
          onFolder={onFolder}
        />
      )}
    </nav>
  );
}

const COLLAPSED_KEY = 'kraken.inbox.labelsCollapsed';

function parseCollapsed(value: string | null): string {
  try {
    const list: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? JSON.stringify(list.filter((x) => typeof x === 'string')) : '[]';
  } catch {
    return '[]';
  }
}

/**
 * The person's labels as Gmail lists them: nested by "/", each row showing
 * its own part of the name, a tag in the label's Gmail colour, and the unread
 * count in bold. Parents fold with an arrow, remembered per browser; the
 * folder on screen always stays in view.
 */
function LabelTreeList({
  labels,
  folder,
  searched,
  unread,
  onFolder,
}: {
  labels: readonly MailLabel[];
  folder: FolderId;
  searched: boolean;
  unread: Record<string, number> | undefined;
  onFolder: (folder: FolderId) => void;
}) {
  const tree = React.useMemo(() => labelTree(labels), [labels]);
  const [stored, setStored] = useStoredChoice<string>(COLLAPSED_KEY, parseCollapsed, '[]');
  const collapsed = React.useMemo(() => new Set<string>(JSON.parse(stored) as string[]), [stored]);
  const current = folder.startsWith('label:')
    ? labels.find((l) => `label:${l.id}` === folder)
    : undefined;
  const keepOpen = new Set(current ? ancestorPaths(current.name) : []);
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setStored(JSON.stringify([...next]));
  };

  const row = (node: LabelNode): React.ReactNode => {
    const open = !collapsed.has(node.path) || keepOpen.has(node.path);
    const id: FolderId | null = node.label ? `label:${node.label.id}` : null;
    const active = !searched && id !== null && folder === id;
    const count = node.label ? (unread?.[node.label.id] ?? 0) : 0;
    const color = node.label?.color;
    return (
      <li key={node.path}>
        <div
          className={cn(
            'flex h-8 w-full items-center rounded-r-full pr-3 text-sm',
            active
              ? 'bg-[var(--nav-active)] text-[var(--fg)]'
              : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
          )}
          style={{ paddingLeft: `${0.25 + node.depth * 1}rem` }}
        >
          {node.children.length ? (
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
              className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-[var(--bg-hover)]"
            >
              {open ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
            </button>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            disabled={id === null}
            onClick={() => id && onFolder(id)}
            aria-current={active ? 'page' : undefined}
            title={node.label?.name ?? node.path}
            className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-1 text-left disabled:cursor-default"
          >
            <Tag
              className="size-4 shrink-0"
              style={color ? { color: color.bg, fill: color.bg } : undefined}
              aria-hidden
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                (count > 0 || active) && 'font-semibold text-[var(--fg)]',
              )}
            >
              {node.name}
            </span>
            {count > 0 ? (
              <span className="shrink-0 text-xs font-semibold text-[var(--fg)]">{count}</span>
            ) : null}
          </button>
        </div>
        {node.children.length && open ? (
          <ul className="space-y-px">{node.children.map(row)}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul className="mt-1 space-y-px" data-label-tree>
      {tree.map(row)}
    </ul>
  );
}
