'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CalendarClock, Handshake, Zap, type LucideIcon } from 'lucide-react';
import { restoreTaskAction, updateTaskStatusAction } from '@/app/actions';
import { useReportRefresh } from '@/components/shell/refresh-status';
import { useTaskActionHost } from '@/components/tasks/task-action-host';
import { Card } from '@/components/ui/card';
import type { Glance, GlanceBucket, GlanceCard, GlanceItem } from '@/lib/tasks/glance';
import type { TaskRestore } from '@/lib/tasks/tasks-view';
import { cn } from '@/lib/util/cn';

const UNDO_MS = 8_000;
const BACK_OPEN: TaskRestore = { status: 'open' };
/** How long a ticked row stays struck through before it folds away (`delay-600` below). */
const FOLD_DELAY_MS = 600;
/** Strike, fold (`--motion-slow`, 320ms) and a little slack: then the row is let go. */
const FOLD_TOTAL_MS = FOLD_DELAY_MS + 320 + 80;

/** A ticked row, kept on screen where it was until it has folded away. */
interface Leaving {
  item: GlanceItem;
  bucket: GlanceBucket;
  index: number;
}

const CARDS: readonly {
  key: GlanceBucket;
  title: string;
  icon: LucideIcon;
  /** Green leads; gold is the one accent, on the card that is about later. */
  chip: string;
}[] = [
  {
    key: 'now',
    title: 'Do now',
    icon: Zap,
    chip: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  },
  {
    key: 'intro',
    title: 'Intros owed',
    icon: Handshake,
    chip: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  },
  {
    key: 'upcoming',
    title: 'Coming up',
    icon: CalendarClock,
    chip: 'bg-[color-mix(in_srgb,var(--glance-gold)_16%,transparent)] text-[var(--glance-gold)]',
  },
];

function without<T>(set: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Today's "At a glance" cards: one short line per task, a tickbox to finish
 * it. A tick completes the task at once: the count drops, the line is struck
 * through and folds away, and an 8-second Undo is offered, run by the
 * layout's task host because the row is gone by the time anyone clicks it.
 *
 * `cards` is which of the three to show, from `todayGlanceCards`: Do now
 * steps aside while today's Top priorities is on the page.
 *
 * The server's answer to the tick already leaves the task out, so a ticked
 * row is held here, in its old place, until its fold has played.
 */
export function TodayGlance({
  glance,
  cards,
  footnote,
}: {
  glance: Glance;
  cards: readonly GlanceBucket[];
  footnote: string;
}) {
  const [done, setDone] = React.useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = React.useState<ReadonlyMap<string, Leaving>>(() => new Map());
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();
  const host = useTaskActionHost();

  const forget = React.useCallback((id: string) => {
    setDone((prev) => without(prev, id));
    setLeaving((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const tick = (row: Leaving, input: HTMLInputElement) => {
    const { item } = row;
    if (done.has(item.id)) return;
    setDone((prev) => new Set(prev).add(item.id));
    setLeaving((prev) => new Map(prev).set(item.id, row));
    moveFocusAfterFold(input);
    const folded = new Promise<void>((resolve) => window.setTimeout(resolve, FOLD_TOTAL_MS));
    reportRefresh();
    startTransition(async () => {
      const result = await updateTaskStatusAction(item.id, 'complete');
      if (!result.ok) {
        forget(item.id);
        toast.error(result.error?.message ?? 'Could not tick that off');
        return;
      }
      toast.success('Done', {
        description: item.label,
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            forget(item.id);
            host.run(() => restoreTaskAction(item.id, BACK_OPEN), {
              success: 'Back on your list',
              error: 'Could not undo',
            });
          },
        },
      });
      router.refresh();
      void folded.then(() => forget(item.id));
    });
  };

  const shown = CARDS.filter((card) => cards.includes(card.key));

  return (
    <section
      aria-labelledby="glance-heading"
      data-tour="today-glance"
      className="@container mb-6 [--glance-gold:var(--label-gold)]"
    >
      <h2 id="glance-heading" className="sr-only">
        At a glance
      </h2>
      {/* Side by side only where each card is wide enough to read its lines
          (about 290px). Three need the cards' own column at 56rem, sidebar
          or not; two fit from the small breakpoint, where the column is at
          least 592px with or without the sidebar. Narrower, the phone's
          single column. A long label wraps to a second line rather than
          being cut. */}
      <div className={cn('grid gap-3', shown.length === 3 ? '@4xl:grid-cols-3' : 'sm:grid-cols-2')}>
        {shown.map((card) => (
          <GlanceCardView
            key={card.key}
            id={card.key}
            title={card.title}
            icon={card.icon}
            chip={card.chip}
            data={glance[card.key]}
            leaving={[...leaving.values()].filter((row) => row.bucket === card.key)}
            done={done}
            onTick={tick}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-[var(--fg-subtle)]">{footnote}</p>
    </section>
  );
}

/** The server's rows, with any ticked row it already dropped put back where it was. */
function withLeaving(items: readonly GlanceItem[], leaving: readonly Leaving[]): GlanceItem[] {
  const present = new Set(items.map((item) => item.id));
  const rows = [...items];
  for (const row of [...leaving].sort((a, b) => a.index - b.index)) {
    if (!present.has(row.item.id)) rows.splice(Math.min(row.index, rows.length), 0, row.item);
  }
  return rows;
}

/**
 * Once the ticked row has folded, focus moves to the next open tickbox on the
 * same card (or the one before it), so a keyboard user keeps their place.
 */
function moveFocusAfterFold(input: HTMLInputElement) {
  window.setTimeout(() => {
    if (document.activeElement !== input) return;
    const list = input.closest('ul');
    if (!list) return;
    const boxes = Array.from(
      list.querySelectorAll<HTMLInputElement>('input[data-glance-check]:not(:checked)'),
    );
    const after = boxes.find(
      (box) => input.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    (after ?? boxes.at(-1))?.focus();
  }, FOLD_DELAY_MS + 50);
}

function GlanceCardView({
  id,
  title,
  icon: Icon,
  chip,
  data,
  leaving,
  done,
  onTick,
}: {
  id: GlanceBucket;
  title: string;
  icon: LucideIcon;
  chip: string;
  data: GlanceCard;
  leaving: readonly Leaving[];
  done: ReadonlySet<string>;
  onTick: (row: Leaving, input: HTMLInputElement) => void;
}) {
  // A ticked row the server still lists is not counted; one it dropped already isn't.
  const ticked = data.items.filter((item) => done.has(item.id)).length;
  const count = Math.max(0, data.total - ticked);
  const more = Math.max(0, data.total - data.items.length);
  const headingId = `glance-${id}`;

  return (
    <Card className="flex flex-col px-3.5 pt-3 pb-2.5 sm:px-4">
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', chip)}>
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <h3 id={headingId} className="text-title font-semibold">
          {title}{' '}
          <span className="tabular font-sans text-sm font-normal text-[var(--fg-subtle)]">
            · {count}
          </span>
        </h3>
      </div>

      {count === 0 && more === 0 ? (
        <p className="py-1.5 pl-9 text-sm text-[var(--fg-subtle)]">Clear</p>
      ) : null}

      <ul aria-labelledby={headingId}>
        {withLeaving(data.items, leaving).map((item, index) => {
          const isDone = done.has(item.id);
          return (
            <li
              key={item.id}
              data-done={isDone || undefined}
              className="grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-[var(--motion-slow)] ease-[var(--ease-exit)] data-done:grid-rows-[0fr] data-done:opacity-0 data-done:delay-600"
            >
              <div className="flex min-h-0 items-center gap-1.5 overflow-hidden">
                <label
                  data-tour="glance-tick"
                  className="-ml-1.5 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-field)] hover:bg-[var(--bg-hover)]"
                >
                  <input
                    type="checkbox"
                    data-glance-check=""
                    checked={isDone}
                    aria-label={item.fullTitle}
                    onChange={(e) => onTick({ item, bucket: id, index }, e.currentTarget)}
                    className="size-4 cursor-pointer accent-[var(--accent)]"
                  />
                </label>
                <span
                  title={item.fullTitle}
                  className={cn(
                    'line-clamp-2 min-w-0 flex-1 text-sm font-medium break-words',
                    isDone && 'text-[var(--fg-muted)] line-through decoration-[var(--accent)]',
                  )}
                >
                  {item.label}
                </span>
                {item.overdue ? (
                  <span
                    role="img"
                    aria-label="overdue"
                    className="size-1.5 shrink-0 rounded-full bg-[var(--danger)]"
                  />
                ) : null}
                {item.when ? (
                  <span
                    className={cn(
                      'tabular shrink-0 text-xs',
                      item.overdue ? 'text-[var(--danger)]' : 'text-[var(--fg-subtle)]',
                    )}
                  >
                    {item.when}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {more > 0 ? (
        <Link
          href="/tasks"
          className="mt-auto self-start pt-1 pl-9 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
        >
          +{more} more
        </Link>
      ) : null}
    </Card>
  );
}
