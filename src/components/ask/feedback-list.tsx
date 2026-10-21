'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, RotateCcw } from 'lucide-react';
import { setFeedbackAlertsAction, setFeedbackStatusAction } from '@/app/actions/feedback';
import type { ActionResult } from '@/app/actions';
import { FeedbackForm } from '@/components/ask/feedback-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, PlainText } from '@/components/ui/feedback';
import { Switch } from '@/components/ui/form';
import { ShowMore } from '@/components/ui/show-more';
import { feedbackCounts, type FeedbackItem, type FeedbackStatus } from '@/lib/feedback/shared';
import { cn } from '@/lib/util/cn';
import { formatDateTime } from '@/lib/util/time';

/**
 * The full Ask page's Feedback tab: every note sent from the Ask Arwin
 * panel's Feedback tab, newest first, with the page it was about. Open and
 * Done are two short lists rather than one long one; each note is marked done
 * (or opened again) in one tap.
 */

/** A note longer than this opens folded to a few lines. */
const FOLD_CHARS = 400;
/** Notes a list shows at first, and each "Show more" adds: never a long scroll. */
const STEP = 20;

const failed = (message: string): ActionResult => ({
  ok: false,
  error: { code: 'internal', message },
});

export function FeedbackList({
  items,
  timeZone,
  canClose,
}: {
  /** Newest first, as the service reads them. */
  items: readonly FeedbackItem[];
  timeZone: string;
  /** A member or above: may mark notes done. */
  canClose: boolean;
}) {
  const [show, setShow] = React.useState<FeedbackStatus>('open');
  const [limit, setLimit] = React.useState<Record<FeedbackStatus, number>>({
    open: STEP,
    done: STEP,
  });
  /**
   * Statuses changed here, ahead of the page catching up. Each holds only
   * while its note's `changedAt` is still the one it was changed over: once
   * the page brings a newer one (this change, or someone else's after it),
   * the page wins.
   */
  const [changed, setChanged] = React.useState<
    Record<string, { status: FeedbackStatus; over: string | null }>
  >({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [, startChange] = React.useTransition();

  const notes = items.map((item) => {
    const local = changed[item.id];
    return local && local.over === item.changedAt && local.status !== item.status
      ? { ...item, status: local.status }
      : item;
  });
  const counts = feedbackCounts(notes);
  const shown = notes.filter((n) => n.status === show);
  const visible = shown.slice(0, limit[show]);

  function change(item: FeedbackItem, status: FeedbackStatus) {
    setBusy(item.id);
    startChange(async () => {
      let result: ActionResult;
      try {
        result = await setFeedbackStatusAction(item.id, status);
      } catch {
        result = failed('That could not be saved. Try again.');
      }
      setBusy(null);
      if (!result.ok) {
        toast.error(result.error?.message ?? 'That could not be saved. Try again.');
        return;
      }
      setChanged((c) => ({ ...c, [item.id]: { status, over: item.changedAt } }));
      toast.success(status === 'done' ? 'Marked done' : 'Back on the open list');
    });
  }

  return (
    <section aria-label="Feedback notes" className="min-w-0">
      <div role="group" aria-label="Show" className="mb-3 flex flex-wrap gap-2">
        {(['open', 'done'] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={show === key}
            onClick={() => setShow(key)}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors duration-[var(--motion-instant)]',
              show === key
                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
            )}
          >
            {key === 'open' ? 'Open' : 'Done'}
            <Badge
              tone={
                show === key ? 'outline' : key === 'open' && counts.open > 0 ? 'warn' : 'neutral'
              }
              className={cn('tabular px-1.5', show === key && 'border-current text-current')}
            >
              {key === 'open' ? counts.open : counts.done}
            </Badge>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={show === 'open' ? 'No open feedback' : 'Nothing marked done yet'}
          description={
            show === 'open'
              ? 'Notes sent from the Feedback tab of the Ask Arwin chat land here, with the page they were about.'
              : 'Notes marked done move here, newest first.'
          }
        />
      ) : (
        <>
          <ul
            aria-label={show === 'open' ? 'Open feedback' : 'Done feedback'}
            className="space-y-3"
          >
            {visible.map((note) => (
              <li key={note.id}>
                <FeedbackNote
                  note={note}
                  timeZone={timeZone}
                  canClose={canClose}
                  busy={busy === note.id}
                  onChange={change}
                />
              </li>
            ))}
          </ul>
          <ShowMore
            shown={visible.length}
            total={shown.length}
            step={STEP}
            onMore={() => setLimit((l) => ({ ...l, [show]: l[show] + STEP }))}
          />
        </>
      )}
    </section>
  );
}

function FeedbackNote({
  note,
  timeZone,
  canClose,
  busy,
  onChange,
}: {
  note: FeedbackItem;
  timeZone: string;
  canClose: boolean;
  busy: boolean;
  onChange: (note: FeedbackItem, status: FeedbackStatus) => void;
}) {
  const long = note.text.length > FOLD_CHARS;
  const [expanded, setExpanded] = React.useState(false);
  const done = note.status === 'done';

  return (
    <article
      aria-label={`Feedback from ${note.by ?? 'someone'}`}
      data-feedback-note=""
      className="rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-4"
    >
      <PlainText text={note.text} maxLines={long && !expanded ? 6 : undefined} />
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-mini mt-1 text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-mini min-w-0 flex-1 text-[var(--fg-muted)]">
          <span className="font-medium text-[var(--fg)]">{note.by ?? 'Someone'}</span>
          {' · '}
          {formatDateTime(note.at, timeZone)}
          {note.path ? (
            <>
              {' · on '}
              <Link
                href={note.path}
                prefetch={false}
                className="text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4 hover:text-[var(--accent-hover)]"
              >
                {note.title ?? note.path}
              </Link>
            </>
          ) : null}
          {done && note.changedAt ? (
            <span className="block text-[var(--fg-subtle)]">
              Done{note.changedBy ? ` by ${note.changedBy}` : ''} ·{' '}
              {formatDateTime(note.changedAt, timeZone)}
            </span>
          ) : null}
        </p>
        {canClose ? (
          <Button
            size="sm"
            variant={done ? 'ghost' : 'secondary'}
            loading={busy}
            onClick={() => onChange(note, done ? 'open' : 'done')}
          >
            {busy ? null : done ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
            {done ? 'Reopen' : 'Mark done'}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The feedback box on the full page, which has no Ask Arwin panel: no page is attached. */
export function FeedbackPageComposer() {
  const router = useRouter();
  const [text, setText] = React.useState('');
  return <FeedbackForm value={text} onChange={setText} onSent={() => router.refresh()} />;
}

/**
 * "Ping my computers when feedback comes in": desktop alerts, for the person
 * looking only, never for a note they sent themselves. Off until turned on.
 */
export function FeedbackAlertsToggle({ initialOn }: { initialOn: boolean | null }) {
  const [on, setOn] = React.useState(initialOn === true);
  const [pending, startSaving] = React.useTransition();
  const id = React.useId();

  if (initialOn === null) {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        Feedback alerts could not be read just now. Reload the page to try again.
      </p>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={on}
        disabled={pending}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
        onCheckedChange={(value) => {
          const next = value === true;
          setOn(next);
          startSaving(async () => {
            let result: ActionResult;
            try {
              result = await setFeedbackAlertsAction(next);
            } catch {
              result = failed('That could not be saved. Try again.');
            }
            if (!result.ok) {
              setOn(!next);
              toast.error(result.error?.message ?? 'That could not be saved. Try again.');
            }
          });
        }}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          Desktop alerts for new feedback
        </label>
        <p id={`${id}-hint`} className="text-mini mt-0.5 text-[var(--fg-muted)]">
          Your computers with desktop alerts on (Settings, Preferences) ping during the day when
          someone else sends feedback. Never for your own notes, never on a phone.
        </p>
      </div>
    </div>
  );
}
