'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck2, CalendarClock, CalendarX2, Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Label, Textarea } from '@/components/ui/form';
import {
  knownZone,
  slotLabel,
  zoneName,
  type PublicBookingView,
  type PublicDay,
  type PublicManagePage,
  type PublicSlot,
  type PublicSlots,
} from '@/lib/booking/public';
import { CANCEL_NOTE_MAX } from '@/lib/booking/request';
import { Shell } from './booking-page';
import { AddToCalendarButton, BookingDetails, bookingZone } from './booking-details';
import { SlotPicker } from './slot-picker';

/**
 * A booking's own page (/meet/<slug>/b/<token>, D-078), like Calendly's: "You
 * have a meeting with Nick", when (the visitor's zone and the host's), where
 * (the call's link, or the place and its map), who is coming, Add to
 * calendar, and two buttons. Reschedule shows the same time picker as the
 * booking page and moves the same calendar event, so it moves for everyone;
 * Cancel takes an optional note for the host and deletes the event, so
 * everyone gets the calendar's cancellation. It names no person as deciding.
 */

const noSubscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;
const serverNull = () => null;

type Mode = 'view' | 'reschedule' | 'cancel';

export function BookingManage({ data, token }: { data: PublicManagePage; token: string }) {
  const detected = React.useSyncExternalStore(noSubscribe, browserZone, serverNull);
  const visitorZone = knownZone(detected) ? detected : null;

  if (data.state !== 'ok' || !data.host || !data.booking) {
    return (
      <Shell firmName="TipTop Ventures">
        <section className="mx-auto max-w-lg py-16 text-center">
          <CalendarX2 className="mx-auto size-8 text-[var(--accent)]" aria-hidden="true" />
          <h1 className="mt-4 font-serif text-2xl font-semibold">This booking is not here</h1>
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            The link may be mistyped, or the booking is gone.
          </p>
          <Link href={`/meet/${data.slug}`} className="link-inline mt-4 inline-block text-sm">
            Go to the booking page
          </Link>
        </section>
      </Shell>
    );
  }
  return (
    <Manage
      slug={data.slug}
      token={token}
      host={data.host}
      initial={data.booking}
      visitorZone={visitorZone}
    />
  );
}

function Manage({
  slug,
  token,
  host,
  initial,
  visitorZone,
}: {
  slug: string;
  token: string;
  host: NonNullable<PublicManagePage['host']>;
  initial: PublicBookingView;
  visitorZone: string | null;
}) {
  const [booking, setBooking] = React.useState(initial);
  const [mode, setMode] = React.useState<Mode>('view');
  const [done, setDone] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const manageUrl = `/meet/${slug}/b/${token}`;
  const api = `/api/meet/${encodeURIComponent(slug)}/booking/${encodeURIComponent(token)}`;
  const zone = bookingZone(booking, visitorZone);
  const live =
    booking.status === 'booked' || booking.status === 'held' || booking.status === 'pending';
  const first = host.displayName.trim().split(/\s+/)[0] || host.displayName;

  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setProblem(null);
    const res = await fetch(`${api}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      booking?: PublicBookingView;
      error?: { message?: string };
    } | null;
    if (res?.ok && json?.ok && json.booking) return json.booking;
    setProblem(json?.error?.message ?? 'That did not go through. Try again.');
    return null;
  };

  const heading =
    booking.status === 'cancelled'
      ? 'This meeting was cancelled'
      : booking.status === 'declined'
        ? 'This time is not booked'
        : booking.status === 'held'
          ? `Your time with ${first} is held`
          : booking.status === 'pending'
            ? `Your request to meet ${host.displayName}`
            : `You have a meeting with ${host.displayName}`;
  const icon =
    booking.status === 'cancelled' || booking.status === 'declined' ? (
      <CalendarX2 className="size-6" aria-hidden="true" />
    ) : booking.status === 'held' ? (
      <Hourglass className="size-6" aria-hidden="true" />
    ) : booking.status === 'pending' ? (
      <CalendarClock className="size-6" aria-hidden="true" />
    ) : (
      <CalendarCheck2 className="size-6" aria-hidden="true" />
    );

  return (
    <Shell firmName={host.firmName || 'TipTop Ventures'}>
      <section
        aria-labelledby="manage-title"
        className="shadow-raised mx-auto max-w-xl rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-5 sm:p-6"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-[var(--gold)] bg-[var(--jewel)] text-[var(--jewel-fg)]">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-micro font-medium tracking-[0.16em] text-[var(--label-gold)] uppercase">
              Your booking
            </p>
            <h1 id="manage-title" className="font-serif text-2xl leading-tight font-semibold">
              {heading}
            </h1>
            {booking.status === 'held' ? (
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                The calendar invitation is on its way.
              </p>
            ) : booking.status === 'pending' ? (
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                You&apos;ll get a calendar invitation once the time is booked.
              </p>
            ) : booking.status === 'declined' ? (
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                It could not go on the calendar. Pick another time on the booking page.
              </p>
            ) : null}
          </div>
        </div>

        {booking.notice ? (
          <Notice tone="info" className="mt-4">
            {booking.notice}
          </Notice>
        ) : null}
        {done ? (
          <div role="status" className="mt-4">
            <Notice tone="info">{done}</Notice>
          </div>
        ) : null}

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <BookingDetails booking={booking} zone={zone} struck={!live} />
        </div>

        {mode === 'reschedule' ? (
          <Reschedule
            api={api}
            booking={booking}
            zone={zone}
            busy={busy}
            onCancel={() => {
              setMode('view');
              setProblem(null);
            }}
            onPick={async (start) => {
              const moved = await post('reschedule', { start });
              if (!moved) return;
              setBooking(moved);
              setMode('view');
              setDone(
                moved.status === 'booked'
                  ? `Rescheduled to ${slotLabel(moved.startsAt, bookingZone(moved, visitorZone))}. Everyone invited gets the update from the calendar.`
                  : `Moved to ${slotLabel(moved.startsAt, bookingZone(moved, visitorZone))}.`,
              );
            }}
          />
        ) : null}

        {mode === 'cancel' ? (
          <CancelForm
            hostFirst={first}
            canReschedule={booking.canReschedule}
            onReschedule={() => {
              setProblem(null);
              setMode('reschedule');
            }}
            busy={busy}
            onKeep={() => {
              setMode('view');
              setProblem(null);
            }}
            onCancel={async (note) => {
              const cancelled = await post('cancel', { note });
              if (!cancelled) return;
              setBooking(cancelled);
              setMode('view');
              setDone(
                initial.status === 'booked'
                  ? `Cancelled. Everyone invited gets the cancellation from the calendar${note.trim() ? `, and ${first} gets your note` : ''}.`
                  : `Cancelled${note.trim() ? `, and ${first} gets your note` : ''}.`,
              );
            }}
          />
        ) : null}

        {problem ? (
          <div role="alert" className="mt-4">
            <Notice tone="warn">{problem}</Notice>
          </div>
        ) : null}

        {mode === 'view' ? (
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-5">
            {booking.canReschedule ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  setDone(null);
                  setMode('reschedule');
                }}
              >
                Reschedule
              </Button>
            ) : null}
            {booking.canCancel ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDone(null);
                  setMode('cancel');
                }}
              >
                Cancel meeting
              </Button>
            ) : null}
            {booking.status === 'booked' ? (
              <AddToCalendarButton
                booking={booking}
                hostName={host.displayName}
                manageUrl={manageUrl}
              />
            ) : live ? null : (
              <Link
                href={`/meet/${slug}`}
                className="inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4 hover:text-[var(--accent-hover)]"
              >
                Book a new time
              </Link>
            )}
          </div>
        ) : null}
        {mode === 'view' && live && !booking.canReschedule && booking.canCancel ? (
          <p className="mt-3 text-xs text-[var(--fg-subtle)]">
            {booking.reschedulesLeft === 0
              ? 'This meeting was moved as many times as it can be. Cancel it and book a new time if this one does not work.'
              : 'Moving it is not open right now. You can still cancel.'}
          </p>
        ) : null}
      </section>
    </Shell>
  );
}

function Reschedule({
  api,
  booking,
  zone,
  busy,
  onCancel,
  onPick,
}: {
  api: string;
  booking: PublicBookingView;
  zone: string;
  busy: boolean;
  onCancel: () => void;
  onPick: (start: string) => void;
}) {
  const [slots, setSlots] = React.useState<PublicSlot[] | null>(null);
  const [days, setDays] = React.useState<PublicDay[] | undefined>(undefined);
  const [months, setMonths] = React.useState<string[] | undefined>(undefined);
  const [message, setMessage] = React.useState<string | null>(null);
  const [start, setStart] = React.useState<string | null>(null);
  const [day, setDay] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    fetch(`${api}/slots`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          (PublicSlots & { ok?: boolean; error?: { message?: string } }) | null;
        if (!live) return;
        if (!res.ok || !json?.ok) {
          setSlots([]);
          setMessage(json?.error?.message ?? 'Open times could not be loaded.');
          return;
        }
        setSlots(json.slots);
        setDays(json.days);
        setMonths(json.months);
        setMessage(
          json.state === 'ok' ? null : (json.message ?? 'Open times could not be loaded.'),
        );
      })
      .catch(() => {
        if (live) {
          setSlots([]);
          setMessage('Open times could not be loaded.');
        }
      });
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <fieldset className="mt-6 space-y-3 border-t border-[var(--border)] pt-5">
      <legend className="sr-only">Pick a new time</legend>
      <p className="text-sm font-medium">Pick a new time</p>
      <p className="text-xs text-[var(--fg-muted)]">
        Times shown in {zoneName(zone)}.{' '}
        {booking.reschedulesLeft === 1 ? 'This is the last move it can take.' : ''}
      </p>
      {slots === null ? (
        <p className="text-sm text-[var(--fg-muted)]" aria-live="polite">
          Finding open times…
        </p>
      ) : message ? (
        <Notice tone="warn">{message}</Notice>
      ) : slots.length === 0 ? (
        <Notice>No other open times right now. You can keep this one, or cancel it.</Notice>
      ) : (
        <SlotPicker
          slots={slots}
          zone={zone}
          value={start}
          onChange={setStart}
          day={day}
          onDay={setDay}
          days={days}
          months={months}
          label="Open days to move it to"
        />
      )}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button
          type="button"
          variant="primary"
          disabled={!start}
          loading={busy}
          onClick={() => start && onPick(start)}
        >
          {start ? `Move to ${slotLabel(start, zone)}` : 'Pick a time'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Keep the current time
        </Button>
      </div>
    </fieldset>
  );
}

function CancelForm({
  hostFirst,
  canReschedule,
  onReschedule,
  busy,
  onKeep,
  onCancel,
}: {
  hostFirst: string;
  canReschedule: boolean;
  onReschedule: () => void;
  busy: boolean;
  onKeep: () => void;
  onCancel: (note: string) => void;
}) {
  const [note, setNote] = React.useState('');
  const uid = React.useId();
  return (
    <div className="mt-6 space-y-3 border-t border-[var(--border)] pt-5">
      {canReschedule ? (
        <p className="text-sm text-[var(--fg-muted)]">
          Need a different time?{' '}
          <button type="button" onClick={onReschedule} className="link-inline">
            Reschedule instead
          </button>
          : it moves the meeting for everyone.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-note`}>
          Note to {hostFirst}{' '}
          <span className="font-normal text-[var(--fg-subtle)]">(optional)</span>
        </Label>
        <Textarea
          id={`${uid}-note`}
          rows={3}
          maxLength={CANCEL_NOTE_MAX}
          value={note}
          placeholder={`Optional: a short note for ${hostFirst}`}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-right text-[11px] text-[var(--fg-subtle)] tabular-nums">
          {note.length}/{CANCEL_NOTE_MAX}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="danger" loading={busy} onClick={() => onCancel(note)}>
          Cancel meeting
        </Button>
        <Button type="button" variant="ghost" onClick={onKeep}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
