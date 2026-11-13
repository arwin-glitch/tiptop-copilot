'use client';

import * as React from 'react';
import {
  AlarmClock,
  Archive,
  Bookmark,
  Check,
  Clock,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { LabelMenu } from '@/components/inbox/label-menu';
import { readerZone, SnoozeMenu } from '@/components/inbox/snooze-menu';
import type { LabelChange, MailLabel } from '@/lib/email/inbox-actions';
import { fullDate, smartDate, type Density } from '@/lib/email/inbox-folders';
import { formatWake } from '@/lib/email/snooze';
import type { LiveThreadRow } from '@/lib/services/inbox-live';
import { colorsByName } from '@/lib/email/label-tree';
import { LabelChip } from '@/components/inbox/label-chip';
import { SenderAvatar } from '@/components/inbox/sender-avatar';
import { cn } from '@/lib/util/cn';

const PAD: Record<Density, string> = {
  compact: 'py-1',
  default: 'py-1.5 @2xl:py-1.5',
  comfortable: 'py-2.5 @2xl:py-2.5',
};

const HOVER_BTN =
  'rounded-full p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]';

export interface RowActions {
  onOpen: () => void;
  onCheck: () => void;
  onStar: () => void;
  onImportant: () => void;
  /** Hover actions; null hides the button (the folder has no such action). */
  onArchive: (() => void) | null;
  onDelete: (() => void) | null;
  onReadToggle: (() => void) | null;
  onSnooze: ((wakeAt: Date) => void) | null;
  onUnsnooze: (() => void) | null;
  onLabel: ((change: LabelChange) => void) | null;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Drag onto a label or folder in the nav (Gmail's drag to label); null when not offered. */
  onDragStart?: ((e: React.DragEvent) => void) | null;
}

/**
 * One conversation in the list, laid out like Gmail's: checkbox, star,
 * important marker, sender ("Name, me 3", bold when unread, "Draft" in the
 * danger colour), label chips, subject — snippet, an attachment marker and
 * the smart date, which hover swaps for archive, delete, read/unread, snooze
 * and label. On a narrow list (the reading pane open, or a phone) the same
 * row stacks on three lines with an avatar initial, as the Gmail app does.
 */
export function ThreadRow({
  row,
  timeZone,
  active,
  checked,
  density,
  labelChoices,
  snoozedUntil,
  actions,
}: {
  row: LiveThreadRow;
  timeZone: string;
  active: boolean;
  checked: boolean;
  density: Density;
  labelChoices: readonly MailLabel[];
  /** On the Snoozed folder: when it comes back, shown in place of the date. */
  snoozedUntil: string | null;
  actions: RowActions;
}) {
  const scheduled = row.kind === 'scheduled';
  const draft = row.kind === 'draft';
  const when = scheduled
    ? formatWake(row.sendAt ?? row.at ?? '', readerZone(timeZone))
    : snoozedUntil
      ? formatWake(snoozedUntil, readerZone(timeZone))
      : smartDate(row.at, timeZone);
  const whenTitle = fullDate(scheduled ? (row.sendAt ?? null) : row.at, timeZone);
  const labelColors = React.useMemo(() => colorsByName(labelChoices), [labelChoices]);
  const hasHoverActions = Boolean(
    actions.onArchive ||
    actions.onDelete ||
    actions.onReadToggle ||
    actions.onSnooze ||
    actions.onUnsnooze ||
    actions.onLabel,
  );

  const sender = (
    <span
      className={cn(
        'min-w-0 truncate text-sm',
        row.unread ? 'font-bold text-[var(--fg)]' : 'text-[var(--fg)]',
      )}
    >
      {row.unread ? <span className="sr-only">Unread: </span> : null}
      {draft ? (
        <span className="text-[var(--danger)]">Draft</span>
      ) : scheduled ? (
        <span className="text-[var(--accent)]">Scheduled</span>
      ) : (
        row.who
      )}
      {(draft || scheduled) && row.who ? <span>{`, ${row.who}`}</span> : null}
      {!draft && !scheduled && row.hasDraft ? (
        <span className="text-[var(--danger)]">, Draft</span>
      ) : null}
      {row.count && row.count > 1 ? (
        <span className="ml-1 text-xs font-normal text-[var(--fg-muted)]">{row.count}</span>
      ) : null}
    </span>
  );

  const chips = (
    <>
      {row.flagged ? (
        <span className="shrink-0 rounded bg-[var(--warn-soft)] px-1.5 text-xs font-medium text-[var(--warn)]">
          Flagged
        </span>
      ) : null}
      {row.inSpam ? (
        <span className="shrink-0 rounded bg-[var(--danger-soft)] px-1.5 text-xs text-[var(--danger)]">
          Spam
        </span>
      ) : null}
      {row.inTrash ? (
        <span className="shrink-0 rounded bg-[var(--neutral-soft)] px-1.5 text-xs text-[var(--fg-muted)]">
          Trash
        </span>
      ) : null}
      {row.labels.map((l) => (
        <LabelChip
          key={l}
          name={l}
          color={labelColors.get(l)}
          className="max-w-32 shrink-0 truncate"
        />
      ))}
    </>
  );

  const dateText = (
    <span
      title={whenTitle}
      className={cn(
        'shrink-0 text-xs tabular-nums',
        row.unread ? 'font-bold text-[var(--fg)]' : 'text-[var(--fg-muted)]',
        (snoozedUntil || scheduled) && 'flex items-center gap-1 font-medium text-[var(--accent)]',
        // Hover (a mouse) or keyboard focus swaps the date for the actions; a tap does not.
        hasHoverActions &&
          'group-hover:hidden group-has-[:focus-visible]:hidden group-has-[[data-state=open]]:hidden',
      )}
    >
      {snoozedUntil ? <AlarmClock className="size-3.5" aria-hidden /> : null}
      {scheduled ? <Clock className="size-3.5" aria-hidden /> : null}
      {snoozedUntil ? <span className="sr-only">Snoozed until </span> : null}
      {scheduled ? <span className="sr-only">Sends </span> : null}
      {when}
    </span>
  );

  const hover = hasHoverActions ? (
    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-has-[:focus-visible]:flex group-has-[[data-state=open]]:flex">
      {actions.onArchive ? (
        <button
          type="button"
          onClick={actions.onArchive}
          aria-label="Archive"
          title="Archive"
          className={HOVER_BTN}
        >
          <Archive className="size-4" aria-hidden />
        </button>
      ) : null}
      {actions.onDelete ? (
        <button
          type="button"
          onClick={actions.onDelete}
          aria-label="Delete"
          title="Delete"
          className={HOVER_BTN}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      ) : null}
      {actions.onReadToggle ? (
        <button
          type="button"
          onClick={actions.onReadToggle}
          aria-label={row.unread ? 'Mark as read' : 'Mark as unread'}
          title={row.unread ? 'Mark as read' : 'Mark as unread'}
          className={HOVER_BTN}
        >
          {row.unread ? (
            <MailOpen className="size-4" aria-hidden />
          ) : (
            <Mail className="size-4" aria-hidden />
          )}
        </button>
      ) : null}
      {actions.onSnooze ? (
        <SnoozeMenu timeZone={timeZone} onSnooze={actions.onSnooze}>
          <button type="button" aria-label="Snooze" title="Snooze" className={HOVER_BTN}>
            <AlarmClock className="size-4" aria-hidden />
          </button>
        </SnoozeMenu>
      ) : null}
      {actions.onUnsnooze ? (
        <button
          type="button"
          onClick={actions.onUnsnooze}
          aria-label="Unsnooze: back to the inbox now"
          title="Unsnooze"
          className={HOVER_BTN}
        >
          <InboxIcon className="size-4" aria-hidden />
        </button>
      ) : null}
      {actions.onLabel ? (
        <LabelMenu choices={labelChoices} current={[row.labelIds]} onChange={actions.onLabel}>
          <button type="button" aria-label="Label" title="Label as" className={HOVER_BTN}>
            <Tag className="size-4" aria-hidden />
          </button>
        </LabelMenu>
      ) : null}
    </span>
  ) : null;

  const canMark = !draft && !scheduled;

  return (
    <li
      onContextMenu={actions.onContextMenu}
      draggable={Boolean(actions.onDragStart)}
      onDragStart={actions.onDragStart ?? undefined}
      className={cn(
        'group relative flex items-center gap-1 border-b border-[var(--border)] pr-3 pl-2 @2xl:gap-2',
        PAD[density],
        row.unread ? 'bg-[var(--bg-raised)]' : 'bg-[var(--bg-sunken)]/40',
        checked && 'bg-[var(--accent-soft)]',
        // Last, so the open thread wins over the unread fill (tailwind-merge
        // keeps the later background). The gold rule is the 3:1 marker.
        active
          ? 'bg-[var(--accent-soft)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--gold)]'
          : 'hover:z-[1] hover:shadow-[inset_1px_0_0_var(--border-strong),inset_-1px_0_0_var(--border-strong),0_1px_3px_rgb(0_0_0/0.12)]',
      )}
    >
      {/* Narrow list: the avatar initial is the checkbox, as in the Gmail app. */}
      <button
        type="button"
        onClick={actions.onCheck}
        aria-label={`${checked ? 'Deselect' : 'Select'} conversation from ${row.who}`}
        aria-pressed={checked}
        className={cn(
          'mr-1 grid size-9 shrink-0 place-items-center self-start rounded-full text-sm font-semibold @2xl:hidden',
          checked
            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
            : 'bg-[var(--nav-active)] text-[var(--accent)]',
        )}
      >
        {checked ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <SenderAvatar name={row.who} email={row.avatarEmail} className="size-9 text-sm" />
        )}
      </button>
      <input
        type="checkbox"
        id={`check-${row.id}`}
        aria-label={`Select ${row.subject}`}
        checked={checked}
        onChange={actions.onCheck}
        className="hidden size-4 shrink-0 @2xl:mx-1.5 @2xl:block"
      />
      {canMark ? (
        <button
          type="button"
          onClick={actions.onStar}
          aria-label={row.starred ? 'Unstar' : 'Star'}
          aria-pressed={row.starred}
          title={row.starred ? 'Starred' : 'Not starred'}
          className="hidden shrink-0 rounded-full p-1 text-[var(--fg-subtle)] hover:text-[var(--gold)] @2xl:block"
        >
          <Star
            className={cn('size-4', row.starred && 'fill-[var(--gold)] text-[var(--gold)]')}
            aria-hidden
          />
        </button>
      ) : null}
      {canMark ? (
        <button
          type="button"
          onClick={actions.onImportant}
          aria-label={row.important ? 'Mark as not important' : 'Mark as important'}
          aria-pressed={row.important}
          title={row.important ? 'Important' : 'Not important'}
          className="hidden shrink-0 rounded-full p-1 text-[var(--fg-subtle)] hover:text-[var(--gold)] @2xl:block"
        >
          <Bookmark
            className={cn('size-4', row.important && 'fill-[var(--gold)] text-[var(--gold)]')}
            aria-hidden
          />
        </button>
      ) : null}

      <button
        type="button"
        onClick={actions.onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left @2xl:flex-row @2xl:items-center @2xl:gap-3"
      >
        {/* Wide list: sender column. Narrow: the first line, with the date. */}
        <span className="flex min-w-0 items-baseline gap-2 @2xl:w-48 @2xl:shrink-0">
          <span className="flex min-w-0 flex-1">{sender}</span>
          <span className="@2xl:hidden">{dateText}</span>
        </span>
        {row.labels.length || row.flagged || row.inSpam || row.inTrash ? (
          <span className="order-last flex flex-wrap items-center gap-1 @2xl:order-none @2xl:shrink-0 @2xl:flex-nowrap">
            {chips}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">
            <span
              data-row-subject
              className={cn(row.unread ? 'font-bold text-[var(--fg)]' : 'text-[var(--fg)]')}
            >
              {row.subject}
            </span>
            {row.snippet ? (
              <span className="hidden text-[var(--fg-muted)] @2xl:inline"> — {row.snippet}</span>
            ) : null}
          </span>
          {row.hasAttachment ? (
            <span
              title="Has an attachment"
              className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg-muted)]"
            >
              <Paperclip className="size-3" aria-hidden />
              <span className="sr-only @2xl:not-sr-only">Attachment</span>
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm text-[var(--fg-muted)] @2xl:hidden">{row.snippet}</span>
      </button>

      <span className="hidden @2xl:block">{dateText}</span>
      {hover}
      {canMark ? (
        <button
          type="button"
          onClick={actions.onStar}
          aria-label={row.starred ? 'Unstar' : 'Star'}
          aria-pressed={row.starred}
          className="self-end rounded-full p-1 text-[var(--fg-subtle)] hover:text-[var(--gold)] @2xl:hidden"
        >
          <Star
            className={cn('size-4', row.starred && 'fill-[var(--gold)] text-[var(--gold)]')}
            aria-hidden
          />
        </button>
      ) : null}
    </li>
  );
}
