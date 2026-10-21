'use client';

import * as React from 'react';
import {
  Bell,
  BellOff,
  ExternalLink,
  Lock,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  Users,
  Video,
} from 'lucide-react';
import { gmailThreadUrl } from '@/lib/deals/links';
import { daySpan } from '@/lib/calendar/grid';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { addDaysToKey, formatDate, formatTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { PlainText, SkeletonText } from '@/components/ui/feedback';
import { fetchContext, type MeetingContext } from './calendar-api';
import { swatchStyle } from './event-style';

/**
 * One event, opened from the grid: what the day list shows for it (Meeting or
 * Block and why, the ping, the people, where it is or the Join link, and for
 * a meeting on the main calendar the context box: the dossier, the prep note
 * and the latest emails), with Edit and Delete when it can be changed here,
 * or a plain note saying why it cannot.
 */

function whenText(event: RangeEvent, timeZone: string): string {
  if (event.allDay || !event.startsAt) {
    const span = daySpan(event, timeZone);
    if (!span) return 'All day';
    const last = addDaysToKey(span.endKey, -1);
    const day = (k: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(new Date(`${k}T12:00:00Z`));
    return last === span.startKey
      ? `${day(span.startKey)} · All day`
      : `${day(span.startKey)} – ${day(last)}`;
  }
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(event.startsAt));
  return `${date} · ${formatTime(event.startsAt, timeZone)}${event.endsAt ? ` – ${formatTime(event.endsAt, timeZone)}` : ''}`;
}

const RESPONSE: Record<string, string> = {
  accepted: 'Going',
  declined: 'Declined',
  tentative: 'Maybe',
  needsAction: 'Not answered',
};

export function EventPanel({
  event,
  calendar,
  timeZone,
  ownEmails,
  mailbox,
  editing,
  editingOffReason,
  onClose,
  onEdit,
  onDelete,
  turnOnHref,
}: {
  event: RangeEvent | null;
  calendar: CalendarInfo | null;
  timeZone: string;
  /** Nick's own addresses: he is never listed among the guests, as in the day list. */
  ownEmails: readonly string[];
  /** The mailbox the "latest emails" links open in. */
  mailbox: string | null;
  /** Calendar editing is on (the grant, or the demo). */
  editing: boolean;
  editingOffReason: string | null;
  onClose: () => void;
  onEdit: (event: RangeEvent) => void;
  onDelete: (event: RangeEvent) => void;
  turnOnHref: string | null;
}) {
  return (
    <Dialog open={event !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      {event ? (
        <Drawer title={event.title} description={whenText(event, timeZone)}>
          <EventDetails
            event={event}
            calendar={calendar}
            timeZone={timeZone}
            ownEmails={ownEmails}
            mailbox={mailbox}
            editing={editing}
            editingOffReason={editingOffReason}
            onEdit={onEdit}
            onDelete={onDelete}
            turnOnHref={turnOnHref}
          />
        </Drawer>
      ) : null}
    </Dialog>
  );
}

function EventDetails({
  event,
  calendar,
  timeZone,
  ownEmails,
  mailbox,
  editing,
  editingOffReason,
  onEdit,
  onDelete,
  turnOnHref,
}: {
  event: RangeEvent;
  calendar: CalendarInfo | null;
  timeZone: string;
  ownEmails: readonly string[];
  mailbox: string | null;
  editing: boolean;
  editingOffReason: string | null;
  onEdit: (event: RangeEvent) => void;
  onDelete: (event: RangeEvent) => void;
  turnOnHref: string | null;
}) {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const people = event.attendees.filter((a) => !a.resource && !a.self && !own.has(a.email));
  const canChange = editing && event.canModify;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full border"
          style={swatchStyle(event.color.background)}
        />
        <span className="text-[var(--fg-muted)]">{calendar?.name ?? 'Calendar'}</span>
        {event.recurringEventId ? (
          <span className="inline-flex items-center gap-1 text-[var(--fg-muted)]">
            <Repeat className="size-3.5" aria-hidden /> Repeats
          </span>
        ) : null}
        {event.timeZone && event.timeZone !== timeZone && !event.allDay ? (
          <span className="text-xs text-[var(--fg-subtle)]">Kept in {event.timeZone}</span>
        ) : null}
      </div>

      {/* The verdict, as the day list words it. */}
      {event.verdict.meeting ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">Meeting</Badge>
          <p className="flex items-center gap-1 text-sm text-[var(--fg-muted)]">
            <Bell className="size-3.5" aria-hidden /> {event.verdict.reason}. Pings 5 min before.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Block</Badge>
          {event.hold ? <Badge tone="outline">Hold</Badge> : null}
          <p className="flex items-center gap-1 text-sm text-[var(--fg-subtle)]">
            <BellOff className="size-3.5" aria-hidden /> {event.verdict.reason}. No ping.
          </p>
        </div>
      )}

      {event.place || event.joinUrl || event.meetPending ? (
        <div className="space-y-1 text-sm">
          {event.place ? (
            <p className="flex items-start gap-1.5 text-[var(--fg-muted)]">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{event.place}</span>
            </p>
          ) : event.location && !event.joinUrl ? (
            <p className="flex items-start gap-1.5 text-[var(--fg-muted)]">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{event.location}</span>
            </p>
          ) : null}
          {event.joinUrl ? (
            <a
              href={event.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 underline-offset-2 hover:underline',
                event.inPerson ? 'text-[var(--fg-muted)]' : 'font-medium text-[var(--accent)]',
              )}
            >
              <Video className="size-4" aria-hidden />
              {event.meetUrl === event.joinUrl ? 'Join with Google Meet' : 'Join'}
            </a>
          ) : event.meetPending ? (
            <p className="text-[var(--fg-muted)]">Google is still making the Meet link.</p>
          ) : null}
        </div>
      ) : null}

      {people.length > 0 ? (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <Users className="size-4" aria-hidden /> {people.length}{' '}
            {people.length === 1 ? 'guest' : 'guests'}
          </p>
          <ul className="space-y-0.5 text-sm">
            {people.map((p) => (
              <li key={p.email} className="flex flex-wrap items-baseline gap-x-2">
                <span className="break-all">{p.name ?? p.email}</span>
                {p.organizer ? (
                  <span className="text-xs text-[var(--fg-subtle)]">Organizer</span>
                ) : null}
                {p.response ? (
                  <span
                    className={cn(
                      'text-xs',
                      p.response === 'declined'
                        ? 'text-[var(--danger)]'
                        : 'text-[var(--fg-subtle)]',
                    )}
                  >
                    {RESPONSE[p.response] ?? p.response}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {event.description ? (
        <PlainText text={event.description} maxLines={8} className="text-[var(--fg-muted)]" />
      ) : null}

      {event.verdict.meeting && calendar?.primary ? (
        <ContextBox event={event} timeZone={timeZone} mailbox={mailbox} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        {canChange ? (
          <>
            <Button size="sm" variant="primary" onClick={() => onEdit(event)}>
              <Pencil aria-hidden /> Edit
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onDelete(event)}>
              <Trash2 aria-hidden /> Delete
            </Button>
          </>
        ) : null}
        {event.htmlLink ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={event.htmlLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden /> Open in Google Calendar
            </a>
          </Button>
        ) : null}
      </div>

      {!event.canModify ? (
        <p className="flex items-start gap-1.5 text-sm text-[var(--fg-muted)]">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>View only: {event.readOnlyReason ?? 'this event cannot be changed here.'}</span>
        </p>
      ) : !editing ? (
        <p className="flex flex-wrap items-start gap-1.5 text-sm text-[var(--fg-muted)]">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{editingOffReason}</span>
          {turnOnHref ? (
            <a href={turnOnHref} className="link-inline font-medium">
              Turn on calendar editing
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** The day list's context box, for one meeting, read when it is opened. */
function ContextBox({
  event,
  timeZone,
  mailbox,
}: {
  event: RangeEvent;
  timeZone: string;
  mailbox: string | null;
}) {
  const [state, setState] = React.useState<
    { status: 'loading' } | { status: 'ready'; context: MeetingContext | null }
  >({ status: 'loading' });
  const date = daySpan(event, timeZone)?.startKey ?? null;

  React.useEffect(() => {
    if (!date) return;
    let live = true;
    void fetchContext(event.id, date).then((res) => {
      if (!live) return;
      setState({
        status: 'ready',
        context: res.ok && res.value.found ? (res.value.context ?? null) : null,
      });
    });
    return () => {
      live = false;
    };
  }, [event.id, date]);

  if (state.status === 'loading') {
    return (
      <div className="rounded-md bg-[var(--bg-hover)] p-3" aria-busy="true">
        <SkeletonText lines={3} />
      </div>
    );
  }
  const { context } = state;
  const dossier = context?.dossier ?? null;
  const recent = context?.recent ?? [];
  return (
    <div className="space-y-1.5 rounded-md bg-[var(--bg-hover)] p-3 text-sm">
      {dossier?.oneThing ? (
        <p>
          <span className="font-medium">The one thing to know: </span>
          {dossier.oneThing}
        </p>
      ) : null}
      <p>
        <span className="font-medium">How you got here: </span>
        {dossier?.howYouGotHere ??
          context?.prep ??
          (recent.length
            ? 'No dossier note for this one yet. The latest emails with them are below.'
            : 'No dossier note and no recent email with them.')}
      </p>
      {dossier && dossier.worthAsking.length > 0 ? (
        <div>
          <p className="font-medium">Worth asking</p>
          <ul className="list-disc pl-5 text-[var(--fg-muted)]">
            {dossier.worthAsking.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {recent.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-[var(--fg-muted)]">Latest emails with them</p>
          <ul className="mt-0.5 space-y-0.5">
            {recent.map((t) => {
              const href = gmailThreadUrl(t.id, mailbox);
              return (
                <li key={t.id} className="text-xs">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      {t.subject} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    t.subject
                  )}
                  {t.at ? (
                    <span className="text-[var(--fg-subtle)]"> · {formatDate(t.at, timeZone)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
