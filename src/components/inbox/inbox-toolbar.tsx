'use client';

import * as React from 'react';
import {
  AlarmClock,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Inbox as InboxIcon,
  Keyboard,
  Mail,
  MailOpen,
  MoreVertical,
  OctagonAlert,
  RefreshCw,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import { LabelMenu } from '@/components/inbox/label-menu';
import { MenuButton, MoveMenu, type MenuItem } from '@/components/inbox/inbox-menus';
import { SnoozeMenu } from '@/components/inbox/snooze-menu';
import type { LabelChange, MailLabel } from '@/lib/email/inbox-actions';
import {
  DENSITIES,
  pageLabel,
  type Density,
  type FolderId,
  type ReadingPane,
} from '@/lib/email/inbox-folders';
import type { LiveThreadRow } from '@/lib/services/inbox-live';
import { cn } from '@/lib/util/cn';

const ICON_BTN =
  'inline-grid size-9 place-items-center rounded-full text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-[var(--focus)]';

export type SelectWhich = 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred';

export interface BulkActions {
  archive: (() => void) | null;
  moveToInbox: (() => void) | null;
  spam: (() => void) | null;
  notSpam: (() => void) | null;
  trash: (() => void) | null;
  restore: (() => void) | null;
  markRead: () => void;
  markUnread: () => void;
  snooze: ((at: Date) => void) | null;
  unsnooze: (() => void) | null;
  label: ((change: LabelChange) => void) | null;
  move: ((to: string) => void) | null;
  important: () => void;
  notImportant: () => void;
  star: () => void;
  unstar: () => void;
  discardDrafts: (() => void) | null;
  cancelScheduled: (() => void) | null;
}

/**
 * Gmail's toolbar over the list: the select-all checkbox and its dropdown,
 * refresh and the ⋮ menu; with conversations selected, the bulk actions in
 * Gmail's order. On the right, "1–50 of N" and the older/newer arrows.
 */
export function InboxToolbar({
  rows,
  checked,
  onSelect,
  onRefresh,
  loading,
  bulk,
  folder,
  timeZone,
  labelChoices,
  selectionLabelIds,
  labelMenuOpen,
  setLabelMenuOpen,
  snoozeMenuOpen,
  setSnoozeMenuOpen,
  moveMenuOpen,
  setMoveMenuOpen,
  page,
  onOlder,
  onNewer,
  density,
  setDensity,
  pane,
  setPane,
  onMarkAllRead,
  onShortcuts,
}: {
  rows: readonly LiveThreadRow[];
  checked: ReadonlySet<string>;
  onSelect: (which: SelectWhich) => void;
  onRefresh: () => void;
  loading: boolean;
  bulk: BulkActions;
  folder: FolderId | null;
  timeZone: string;
  labelChoices: readonly MailLabel[];
  selectionLabelIds: readonly (readonly string[])[];
  labelMenuOpen: boolean;
  setLabelMenuOpen: (open: boolean) => void;
  snoozeMenuOpen: boolean;
  setSnoozeMenuOpen: (open: boolean) => void;
  moveMenuOpen: boolean;
  setMoveMenuOpen: (open: boolean) => void;
  page: {
    start: number;
    shown: number;
    total: number | null;
    hasOlder: boolean;
    hasNewer: boolean;
  };
  onOlder: () => void;
  onNewer: () => void;
  density: Density;
  setDensity: (d: Density) => void;
  pane: ReadingPane;
  setPane: (p: ReadingPane) => void;
  onMarkAllRead: (() => void) | null;
  onShortcuts: () => void;
}) {
  const some = checked.size > 0;
  const all = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const boxRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (boxRef.current) boxRef.current.indeterminate = some && !all;
  }, [some, all]);

  const selectItems: MenuItem[] = (
    [
      ['all', 'All'],
      ['none', 'None'],
      ['read', 'Read'],
      ['unread', 'Unread'],
      ['starred', 'Starred'],
      ['unstarred', 'Unstarred'],
    ] as const
  ).map(([id, label]) => ({ id, label, onSelect: () => onSelect(id) }));

  const moreItems: MenuItem[] = some
    ? [
        { id: 'unread', label: 'Mark as unread', icon: Mail, onSelect: bulk.markUnread },
        { id: 'read', label: 'Mark as read', icon: MailOpen, onSelect: bulk.markRead },
        { id: 'imp', label: 'Mark as important', icon: ShieldCheck, onSelect: bulk.important },
        {
          id: 'notimp',
          label: 'Mark as not important',
          icon: ShieldCheck,
          onSelect: bulk.notImportant,
        },
        { id: 'star', label: 'Add star', onSelect: bulk.star },
        { id: 'unstar', label: 'Remove star', onSelect: bulk.unstar },
      ]
    : [
        ...(onMarkAllRead
          ? [{ id: 'allread', label: 'Mark all as read', icon: MailOpen, onSelect: onMarkAllRead }]
          : []),
        ...DENSITIES.map((d, i) => ({
          id: `density-${d}`,
          label: `Density: ${d[0]!.toUpperCase()}${d.slice(1)}`,
          checked: density === d,
          divider: i === 0 && Boolean(onMarkAllRead),
          onSelect: () => setDensity(d),
        })),
        {
          id: 'pane-none',
          label: 'Reading pane: No split',
          checked: pane === 'none',
          divider: true,
          onSelect: () => setPane('none'),
        },
        {
          id: 'pane-right',
          label: 'Reading pane: Right of inbox',
          checked: pane === 'right',
          onSelect: () => setPane('right'),
        },
        {
          id: 'keys',
          label: 'Keyboard shortcuts',
          icon: Keyboard,
          divider: true,
          onSelect: onShortcuts,
        },
      ];

  return (
    <div
      role="toolbar"
      aria-label="List actions"
      className="flex min-h-12 items-center gap-0.5 border-b border-[var(--border)] px-2"
    >
      <span className="flex items-center rounded hover:bg-[var(--bg-hover)]">
        <input
          ref={boxRef}
          type="checkbox"
          aria-label={all ? 'Deselect all' : 'Select all'}
          checked={all}
          onChange={() => onSelect(some ? 'none' : 'all')}
          className="m-2 size-4"
        />
        <MenuButton label="Select" items={selectItems}>
          <button type="button" aria-label="Select which" className="-ml-1.5 p-1">
            <ChevronDown className="size-3.5 text-[var(--fg-muted)]" aria-hidden />
          </button>
        </MenuButton>
      </span>

      {!some ? (
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh"
          disabled={loading}
          className={ICON_BTN}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden />
        </button>
      ) : (
        <>
          {bulk.archive ? (
            <button
              type="button"
              onClick={bulk.archive}
              aria-label="Archive"
              title="Archive"
              className={ICON_BTN}
            >
              <Archive className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.moveToInbox ? (
            <button
              type="button"
              onClick={bulk.moveToInbox}
              aria-label="Move to Inbox"
              title="Move to Inbox"
              className={ICON_BTN}
            >
              <InboxIcon className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.spam ? (
            <button
              type="button"
              onClick={bulk.spam}
              aria-label="Report spam"
              title="Report spam"
              className={ICON_BTN}
            >
              <OctagonAlert className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.notSpam ? (
            <button
              type="button"
              onClick={bulk.notSpam}
              title="Not spam"
              className="h-8 rounded-md px-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
            >
              Not spam
            </button>
          ) : null}
          {bulk.trash ? (
            <button
              type="button"
              onClick={bulk.trash}
              aria-label="Delete"
              title="Delete"
              className={ICON_BTN}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.restore ? (
            <button
              type="button"
              onClick={bulk.restore}
              title="Restore to Inbox"
              className="h-8 rounded-md px-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
            >
              Restore
            </button>
          ) : null}
          {bulk.discardDrafts ? (
            <button
              type="button"
              onClick={bulk.discardDrafts}
              title="Discard drafts (to Trash)"
              className="h-8 rounded-md px-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
            >
              Discard drafts
            </button>
          ) : null}
          {bulk.cancelScheduled ? (
            <button
              type="button"
              onClick={bulk.cancelScheduled}
              title="Cancel send"
              className="h-8 rounded-md px-2 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
            >
              Cancel send
            </button>
          ) : null}
          <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
          {!bulk.discardDrafts && !bulk.cancelScheduled ? (
            <button
              type="button"
              onClick={bulk.markRead}
              aria-label="Mark as read"
              title="Mark as read"
              className={ICON_BTN}
            >
              <MailOpen className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.snooze ? (
            <SnoozeMenu
              timeZone={timeZone}
              onSnooze={bulk.snooze}
              open={snoozeMenuOpen}
              onOpenChange={setSnoozeMenuOpen}
            >
              <button type="button" aria-label="Snooze" title="Snooze" className={ICON_BTN}>
                <AlarmClock className="size-4" aria-hidden />
              </button>
            </SnoozeMenu>
          ) : null}
          {bulk.unsnooze ? (
            <button
              type="button"
              onClick={bulk.unsnooze}
              aria-label="Unsnooze"
              title="Unsnooze"
              className={ICON_BTN}
            >
              <Undo2 className="size-4" aria-hidden />
            </button>
          ) : null}
          {bulk.move ? (
            <MoveMenu
              labels={labelChoices}
              current={
                folder === 'inbox' ? 'INBOX' : folder?.startsWith('label:') ? folder.slice(6) : null
              }
              onMove={bulk.move}
              open={moveMenuOpen}
              onOpenChange={setMoveMenuOpen}
            >
              <button type="button" aria-label="Move to" title="Move to" className={ICON_BTN}>
                <FolderInput className="size-4" aria-hidden />
              </button>
            </MoveMenu>
          ) : null}
          {bulk.label ? (
            <LabelMenu
              choices={labelChoices}
              current={selectionLabelIds}
              onChange={bulk.label}
              open={labelMenuOpen}
              onOpenChange={setLabelMenuOpen}
            >
              <button type="button" aria-label="Label" title="Label as" className={ICON_BTN}>
                <Tag className="size-4" aria-hidden />
              </button>
            </LabelMenu>
          ) : null}
        </>
      )}
      {!bulk.discardDrafts && !bulk.cancelScheduled ? (
        <MenuButton label="More" items={moreItems}>
          <button type="button" aria-label="More" title="More" className={ICON_BTN}>
            <MoreVertical className="size-4" aria-hidden />
          </button>
        </MenuButton>
      ) : null}
      {some ? (
        <span className="ml-1 text-sm text-[var(--fg-muted)]" aria-live="polite">
          {checked.size} selected
        </span>
      ) : null}

      <span className="ml-auto flex items-center gap-1 text-xs text-[var(--fg-muted)]">
        <span className="hidden tabular-nums sm:inline" aria-live="polite">
          {pageLabel(page.start, page.shown, page.total)}
        </span>
        <button
          type="button"
          onClick={onNewer}
          disabled={!page.hasNewer}
          aria-label="Newer"
          title="Newer"
          className={ICON_BTN}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onOlder}
          disabled={!page.hasOlder}
          aria-label="Older"
          title="Older"
          className={ICON_BTN}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </span>
    </div>
  );
}
