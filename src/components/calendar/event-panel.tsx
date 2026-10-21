'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  AlignLeft,
  Bell,
  BellOff,
  CalendarDays,
  Check,
  Copy,
  CopyPlus,
  ExternalLink,
  Lock,
  Mail,
  MapPin,
  Paperclip,
  Pencil,
  Repeat,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import { RSVP_CHOICES, type EventOptions, type RsvpResponse } from '@/lib/calendar/event-actions';
import {
  descriptionParts,
  mapsUrl,
  recurrenceSummary,
  responseCounts,
  responseSummary,
} from '@/lib/calendar/event-text';
import { daySpan } from '@/lib/calendar/grid';
import type { CalendarInfo, EventPaletteEntry, RangeEvent } from '@/lib/calendar/range-types';
import { addDaysToKey, formatDate, formatTime, localDateKey } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonText } from '@/components/ui/feedback';
import { ThreadLinks } from '@/components/email/thread-links';
import { AnchoredCard } from './anchored-card';
import { fetchContext, fetchSeries, type MeetingContext } from './calendar-api';
import { swatchStyle, tickStyle } from './event-style';

/**
 * One event, opened by a click on it in Day, Week or Month: Google Calendar's
 * event card, next to the event (a sheet from the bottom on a phone), with
 * its options as they apply here:
 *
 * - Edit, Delete, Duplicate and Email guests along the top, as Google lays
 *   them out; Google's event colours right on the card; Going? Yes / No /
 *   Maybe when Nick is a guest; Join with Google Meet and Copy the link; the
 *   place as a Maps link; Open in Google Calendar for the rest.
 * - What Google shows (the time and its zone, how it repeats, the calendar,
 *   the guests and their answers, the organizer, the description with its
 *   links, attachments), plus Copilot's Meeting or Block verdict and why, the
 *   ping, and for a meeting on the main calendar the day list's context box.
 *
 * Without calendar editing, or on an event this account cannot change, only
 * what writes nothing is offered, with the reason (and how to turn editing on).
 */

function dayWords(key: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${key}T12:00:00Z`));
}

function whenText(event: RangeEvent, timeZone: string): string {
  if (event.allDay || !event.startsAt) {
    const span = daySpan(event, timeZone);
    if (!span) return 'All day';
    const last = addDaysToKey(span.endKey, -1);
    return last === span.startKey
      ? `${dayWords(span.startKey)} · All day`
      : `${dayWords(span.startKey)} – ${dayWords(last)}`;
  }
  const startDay = localDateKey(new Date(event.startsAt), timeZone);
  const endDay = event.endsAt
    ? localDateKey(new Date(Date.parse(event.endsAt) - 1), timeZone)
    : startDay;
  const start = formatTime(event.startsAt, timeZone);
  if (!event.endsAt) return `${dayWords(startDay)} · ${start}`;
  const end = formatTime(event.endsAt, timeZone);
  return endDay === startDay
    ? `${dayWords(startDay)} · ${start} – ${end}`
    : `${dayWords(startDay)}, ${start} – ${dayWords(endDay)}, ${end}`;
}

/** "Central Time": the zone the times are shown in, right on both sides of a clock change. */
function zoneWords(timeZone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  );
}

const RESPONSE: Record<string, string> = {
  accepted: 'Yes',
  declined: 'No',
  tentative: 'Maybe',
  needsAction: 'Awaiting',
};

export interface CardAnchor {
  element: HTMLElement | null;
}

export function EventPanel({
  event,
  anchor,
  phone,
  calendar,
  palette,
  options,
  timeZone,
  ownEmails,
  mailbox,
  editing,
  editingOffReason,
  turnOnHref,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
  onColor,
  onRespond,
  onEmailGuests,
}: {
  event: RangeEvent | null;
  anchor: CardAnchor | null;
  phone: boolean;
  calendar: CalendarInfo | null;
  palette: EventPaletteEntry[];
  options: EventOptions | null;
  timeZone: string;
  /** Nick's own addresses: he is never listed among the guests, as in the day list. */
  ownEmails: readonly string[];
  /** The mailbox the "latest emails" links open in. */
  mailbox: string | null;
  /** Calendar editing is on (the grant, or the demo). */
  editing: boolean;
  editingOffReason: string | null;
  turnOnHref: string | null;
  onClose: () => void;
  onEdit: (event: RangeEvent) => void;
  onDelete: (event: RangeEvent) => void;
  onDuplicate: (event: RangeEvent) => void;
  onColor: (event: RangeEvent, colorId: string | null) => void;
  onRespond: (event: RangeEvent, response: RsvpResponse) => void;
  onEmailGuests: (event: RangeEvent) => void;
}) {
  const open = event !== null && options !== null;
  return (
    <AnchoredCard
      // One card per event: a card closing as another opens cannot close the new one.
      key={event?.key ?? 'none'}
      open={open}
      getAnchor={() => {
        // The element clicked, or the event's chip drawn again since (saved, recoloured).
        const el = anchor?.element;
        if (el?.isConnected || !event) return el ?? null;
        return document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(event.key)}"]`);
      }}
      phone={phone}
      label={event?.title ?? 'Event'}
      onClose={onClose}
      data-event-card=""
    >
      {event && options ? (
        <EventCardBody
          key={event.key}
          event={event}
          calendar={calendar}
          palette={palette}
          options={options}
          timeZone={timeZone}
          ownEmails={ownEmails}
          mailbox={mailbox}
          editing={editing}
          editingOffReason={editingOffReason}
          turnOnHref={turnOnHref}
          onClose={onClose}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onColor={onColor}
          onRespond={onRespond}
          onEmailGuests={onEmailGuests}
        />
      ) : null}
    </AnchoredCard>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="size-8"
    >
      {children}
    </Button>
  );
}

function Row({
  icon: Icon,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-3 text-sm', className)}>
      <Icon className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function EventCardBody({
  event,
  calendar,
  palette,
  options,
  timeZone,
  ownEmails,
  mailbox,
  editing,
  editingOffReason,
  turnOnHref,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
  onColor,
  onRespond,
  onEmailGuests,
}: {
  event: RangeEvent;
  calendar: CalendarInfo | null;
  palette: EventPaletteEntry[];
  options: EventOptions;
  timeZone: string;
  ownEmails: readonly string[];
  mailbox: string | null;
  editing: boolean;
  editingOffReason: string | null;
  turnOnHref: string | null;
  onClose: () => void;
  onEdit: (event: RangeEvent) => void;
  onDelete: (event: RangeEvent) => void;
  onDuplicate: (event: RangeEvent) => void;
  onColor: (event: RangeEvent, colorId: string | null) => void;
  onRespond: (event: RangeEvent, response: RsvpResponse) => void;
  onEmailGuests: (event: RangeEvent) => void;
}) {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const people = event.attendees.filter((a) => !a.resource && !a.self && !own.has(a.email));
  const counts = responseSummary(responseCounts(people));
  const link = event.meetUrl ?? event.joinUrl;
  const isMeet = Boolean(event.meetUrl) && event.meetUrl === event.joinUrl;
  // A real place gets a Maps link; a dial-in or a link in the location is shown as it is.
  const place = event.place ?? (event.location && !event.joinUrl ? event.location : null);
  const placeIsLink = place ? /^https?:\/\//i.test(place.trim()) : false;
  // Someone else's event: who organizes it (Nick's own say which calendar below).
  const organizerText =
    event.organizer && !event.organizer.self
      ? (event.organizer.name ?? event.organizer.email)
      : null;
  const organizerListed = people.some((p) => p.organizer);

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success(isMeet ? 'Meet link copied.' : 'Link copied.');
    } catch {
      toast.error('Could not copy. Select the link and copy it.');
    }
  };

  return (
    <div className="pb-3">
      {/* Google's toolbar: the options that change it, then close. */}
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        {options.edit ? (
          <ToolButton label="Edit event" onClick={() => onEdit(event)}>
            <Pencil aria-hidden />
          </ToolButton>
        ) : null}
        {options.delete ? (
          <ToolButton label="Delete event" onClick={() => onDelete(event)}>
            <Trash2 aria-hidden />
          </ToolButton>
        ) : null}
        {options.duplicate ? (
          <ToolButton label="Duplicate" onClick={() => onDuplicate(event)}>
            <CopyPlus aria-hidden />
          </ToolButton>
        ) : null}
        {options.emailGuests ? (
          <ToolButton label="Email guests" onClick={() => onEmailGuests(event)}>
            <Mail aria-hidden />
          </ToolButton>
        ) : null}
        {options.openInGoogle && event.htmlLink ? (
          <Button
            size="icon"
            variant="ghost"
            asChild
            className="size-8"
            title="Open in Google Calendar"
          >
            <a
              href={event.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Google Calendar (new tab)"
            >
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        <ToolButton label="Close" onClick={onClose}>
          <X aria-hidden />
        </ToolButton>
      </div>

      <div className="space-y-3 px-4">
        {/* Title, time, zone, repeat. */}
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-1.5 size-3.5 shrink-0 rounded-[4px] border"
            style={swatchStyle(event.color.background)}
          />
          <div className="min-w-0 flex-1">
            <h3 className="font-serif text-lg leading-snug font-semibold break-words">
              {event.title}
            </h3>
            <p className="text-sm">{whenText(event, timeZone)}</p>
            {!event.allDay ? (
              <p className="text-xs text-[var(--fg-muted)]">
                {zoneWords(timeZone)}
                {event.timeZone && event.timeZone !== timeZone
                  ? ` · the event keeps ${event.timeZone}`
                  : ''}
              </p>
            ) : null}
            {event.recurringEventId ? (
              <RepeatLine
                calendarId={event.calendarId}
                seriesId={event.recurringEventId}
                timeZone={timeZone}
              />
            ) : null}
          </div>
        </div>

        {/* Copilot's verdict, as the day list words it. */}
        {event.verdict.meeting ? (
          <Row icon={Bell}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone="ok">Meeting</Badge>
              <span className="text-[var(--fg-muted)]">
                {event.verdict.reason}. Pings 5 min before.
              </span>
            </div>
          </Row>
        ) : (
          <Row icon={BellOff}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone="neutral">Block</Badge>
              {event.hold ? <Badge tone="outline">Hold</Badge> : null}
              <span className="text-[var(--fg-subtle)]">{event.verdict.reason}. No ping.</span>
            </div>
          </Row>
        )}

        {/* Join with Google Meet, and the link to copy. */}
        {options.join && event.joinUrl ? (
          <Row icon={Video}>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant={event.inPerson ? 'secondary' : 'primary'} asChild>
                <a href={event.joinUrl} target="_blank" rel="noopener noreferrer">
                  {isMeet ? 'Join with Google Meet' : 'Join'}
                </a>
              </Button>
              {options.copyLink ? (
                <Button size="sm" variant="ghost" onClick={() => void copyLink()}>
                  <Copy aria-hidden /> {isMeet ? 'Copy Meet link' : 'Copy join link'}
                </Button>
              ) : null}
            </div>
            <p className="mt-1 truncate text-xs text-[var(--fg-muted)]" title={event.joinUrl}>
              {event.joinUrl.replace(/^https:\/\//, '')}
            </p>
          </Row>
        ) : event.meetPending ? (
          <Row icon={Video}>
            <p className="text-[var(--fg-muted)]">Google is still making the Meet link.</p>
          </Row>
        ) : null}

        {place ? (
          <Row icon={MapPin}>
            {placeIsLink ? (
              <span className="break-words">{place}</span>
            ) : (
              <a
                href={mapsUrl(place)}
                target="_blank"
                rel="noopener noreferrer"
                className="link-inline break-words"
                title="Open in Google Maps"
              >
                {place}
              </a>
            )}
          </Row>
        ) : null}

        {people.length > 0 || organizerText ? (
          <Row icon={Users}>
            {people.length > 0 ? (
              <p>
                <span className="font-medium">
                  {people.length} {people.length === 1 ? 'guest' : 'guests'}
                </span>
                {counts ? <span className="text-[var(--fg-muted)]"> · {counts}</span> : null}
              </p>
            ) : null}
            {organizerText && !organizerListed ? (
              <p className="text-xs text-[var(--fg-muted)]">Organizer: {organizerText}</p>
            ) : null}
            {people.length > 0 ? (
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                {people.map((p) => (
                  <li key={p.email} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all">{p.name ?? p.email}</span>
                    {p.organizer ? (
                      <span className="text-xs text-[var(--fg-subtle)]">Organizer</span>
                    ) : null}
                    {p.optional ? (
                      <span className="text-xs text-[var(--fg-subtle)]">Optional</span>
                    ) : null}
                    <span
                      className={cn(
                        'text-xs',
                        p.response === 'declined'
                          ? 'text-[var(--danger)]'
                          : p.response === 'accepted'
                            ? 'text-[var(--ok)]'
                            : 'text-[var(--fg-subtle)]',
                      )}
                    >
                      {RESPONSE[p.response ?? 'needsAction'] ?? p.response}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Row>
        ) : null}

        {event.description ? <Description text={event.description} /> : null}

        {event.attachments.length > 0 ? (
          <Row icon={Paperclip}>
            <ul className="space-y-0.5">
              {event.attachments.map((a) => (
                <li key={a.url}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-inline break-words"
                  >
                    {a.title}
                  </a>
                </li>
              ))}
            </ul>
          </Row>
        ) : null}

        <Row icon={CalendarDays}>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full border"
              style={swatchStyle(calendar?.color.background ?? event.color.background)}
            />
            {calendar?.name ?? 'Calendar'}
          </span>
        </Row>

        {event.verdict.meeting && calendar?.primary ? (
          <ContextBox event={event} timeZone={timeZone} mailbox={mailbox} />
        ) : null}

        {options.color && palette.length > 0 ? (
          <ColorRow event={event} calendar={calendar} palette={palette} onColor={onColor} />
        ) : null}

        {options.rsvp ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3 text-sm">
            <span className="font-medium" id={`going-${event.id}`}>
              Going?
            </span>
            <div
              role="group"
              aria-labelledby={`going-${event.id}`}
              className="flex flex-wrap gap-1.5"
            >
              {RSVP_CHOICES.map((c) => {
                const on = event.myResponse === c.value;
                return (
                  <Button
                    key={c.value}
                    size="sm"
                    variant={on ? 'primary' : 'secondary'}
                    aria-pressed={on}
                    onClick={() => onRespond(event, c.value)}
                  >
                    {on ? <Check aria-hidden /> : null}
                    {c.label}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}

        {!editing ? (
          <p className="flex flex-wrap items-start gap-1.5 text-sm text-[var(--fg-muted)]">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{editingOffReason}</span>
            {turnOnHref ? (
              <a href={turnOnHref} className="link-inline font-medium">
                Turn on calendar editing
              </a>
            ) : null}
          </p>
        ) : !event.canModify ? (
          <p className="flex items-start gap-1.5 text-sm text-[var(--fg-muted)]">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {event.canRespond ? '' : 'View only: '}
              {event.readOnlyReason ?? 'this event cannot be changed here.'}
              {event.canRespond ? ' You can still answer it and pick your colour.' : ''}
            </span>
          </p>
        ) : null}

        {event.htmlLink ? (
          <p className="border-t border-[var(--border)] pt-2 text-xs text-[var(--fg-muted)]">
            <a
              href={event.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              className="link-inline inline-flex items-center gap-1 font-medium"
            >
              Open in Google Calendar <ExternalLink className="size-3" aria-hidden />
            </a>{' '}
            to print it, publish it, change its owner or find a time.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** "Weekly on Monday, 12 times", read from the series when the card opens. */
function RepeatLine({
  calendarId,
  seriesId,
  timeZone,
}: {
  calendarId: string;
  seriesId: string;
  timeZone: string;
}) {
  const [summary, setSummary] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void fetchSeries(calendarId, seriesId).then((res) => {
      if (!live || !res.ok) return;
      const start = res.value.start;
      const first = start?.date
        ? start.date
        : start?.dateTime
          ? localDateKey(new Date(start.dateTime), start.timeZone ?? timeZone)
          : null;
      setSummary(recurrenceSummary(res.value.recurrence, first));
    });
    return () => {
      live = false;
    };
  }, [calendarId, seriesId, timeZone]);
  return (
    <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-[var(--fg-muted)]">
      <Repeat className="size-3.5" aria-hidden /> {summary ?? 'Repeats'}
    </p>
  );
}

/** The description as words and links: nothing of an invite's HTML is ever drawn. */
function Description({ text }: { text: string }) {
  const parts = React.useMemo(() => descriptionParts(text), [text]);
  const [more, setMore] = React.useState(false);
  const long = text.length > 420 || text.split('\n').length > 8;
  if (parts.length === 0) return null;
  return (
    <Row icon={AlignLeft}>
      <div
        className={cn(
          'break-words whitespace-pre-wrap text-[var(--fg-muted)]',
          long && !more && 'line-clamp-8',
        )}
      >
        {parts.map((p, i) =>
          p.type === 'text' ? (
            <React.Fragment key={i}>{p.text}</React.Fragment>
          ) : (
            <React.Fragment key={i}>
              <a
                href={p.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="link-inline"
                title={p.href}
              >
                {p.label}
              </a>
              {p.host ? <span className="text-xs text-[var(--fg-subtle)]"> ({p.host})</span> : null}
            </React.Fragment>
          ),
        )}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          className="mt-0.5 text-xs font-medium text-[var(--accent)] hover:underline"
        >
          {more ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </Row>
  );
}

/** Google's event colours, right on the card: one tap recolours it, and nobody is emailed. */
function ColorRow({
  event,
  calendar,
  palette,
  onColor,
}: {
  event: RangeEvent;
  calendar: CalendarInfo | null;
  palette: EventPaletteEntry[];
  onColor: (event: RangeEvent, colorId: string | null) => void;
}) {
  const swatches = [
    {
      id: null as string | null,
      name: `Calendar colour${calendar ? ` (${calendar.name})` : ''}`,
      background: calendar?.color.background ?? event.color.background,
    },
    ...palette.map((p) => ({ id: p.id as string | null, name: p.name, background: p.background })),
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Event colour"
      className="flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-3"
    >
      {swatches.map((s) => {
        const on = (event.colorId ?? null) === s.id;
        return (
          <button
            key={s.id ?? 'calendar'}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={s.name}
            title={s.name}
            onClick={() => (on ? undefined : onColor(event, s.id))}
            className={cn(
              'flex size-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
              on ? 'border-[var(--fg)]' : 'border-transparent',
            )}
          >
            <span
              aria-hidden
              className="flex size-5 items-center justify-center rounded-full border"
              style={swatchStyle(s.background)}
            >
              {on ? <Check className="size-3" style={tickStyle(s.background)} /> : null}
            </span>
          </button>
        );
      })}
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
            {recent.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="min-w-0 break-words">
                  {t.subject}
                  {t.at ? (
                    <span className="text-[var(--fg-subtle)]"> · {formatDate(t.at, timeZone)}</span>
                  ) : null}
                </span>
                {/* The thread in Copilot's Inbox, or in Gmail, as on the day list. */}
                <ThreadLinks id={t.id} mailbox={mailbox} label={t.subject} variant="text" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
