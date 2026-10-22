'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  CalendarDays,
  Coffee,
  ExternalLink,
  FileText,
  MapPin,
  MessageSquare,
  Users,
  Video,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, Notice, Skeleton } from '@/components/ui/feedback';
import { Label, Textarea } from '@/components/ui/form';
import { KIND_LABEL, TYPE_LABEL } from '@/lib/booking/config';
import { dayKeyIn, slotLabel, timeLabel, zoneName } from '@/lib/booking/public';
import { BOOKING_SCOPES, type BookingScope } from '@/lib/booking/tabs';
import { relativeTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { useBookings } from './hooks';
import type { TabBooking } from './types';

const SCOPE_LABEL: Record<BookingScope, string> = {
  upcoming: 'Upcoming',
  past: 'Past',
  messages: 'Messages',
};

const STATUS: Record<
  TabBooking['status'],
  { label: string; tone: 'ok' | 'warn' | 'info' | 'neutral' | 'danger' }
> = {
  booked: { label: 'Booked', tone: 'ok' },
  held: { label: 'Held', tone: 'warn' },
  pending: { label: 'Waiting', tone: 'info' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  declined: { label: 'Declined', tone: 'neutral' },
  message: { label: 'Message', tone: 'neutral' },
};

const httpsOnly = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

export interface BookingsPanelProps {
  scope: BookingScope;
  hostZone: string;
  canCancel: boolean;
  /** The approve-first requests drawer, when any request waits (approve/decline live there). */
  waiting: React.ReactNode;
  waitingCount: number;
}

/**
 * Bookings: upcoming, past and messages from the bookings API, each with
 * who, when (host time, and the visitor's when it differs), call or in
 * person and where, guests, the note and the deck, its status, and Cancel
 * (with an optional note) or Open in Calendar. Requests waiting for
 * approval (Approve first) open in the drawer they always had.
 */
export function BookingsPanel(props: BookingsPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [scope, setScope] = React.useState<BookingScope>(props.scope);
  const [version, setVersion] = React.useState(0);
  const [cancelling, setCancelling] = React.useState<TabBooking | null>(null);
  const list = useBookings(scope, version);

  const go = (next: BookingScope) => {
    setScope(next);
    const params = new URLSearchParams(search.toString());
    params.set('tab', 'bookings');
    if (next === 'upcoming') params.delete('scope');
    else params.set('scope', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-4">
      {props.waitingCount > 0 ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--info)]/30 bg-[var(--info-soft)] p-3"
          data-tour="booking-waiting"
        >
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-semibold">{props.waitingCount} waiting for approval.</span> Each
            one goes on the calendar when someone approves it.
          </p>
          {props.waiting}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Which bookings" className="flex flex-wrap gap-1.5">
          {BOOKING_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              onClick={() => go(s)}
              className={cn(
                'h-9 rounded-full border px-3.5 text-sm font-medium transition-colors',
                scope === s
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                  : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--fg-muted)]">Times in {zoneName(props.hostZone)}.</p>
      </div>

      {list.state === 'loading' ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : list.state === 'missing' ? (
        <Notice>The bookings list is not switched on in this version yet.</Notice>
      ) : list.state === 'error' ? (
        <Notice tone="warn">{list.message}</Notice>
      ) : list.bookings.length === 0 ? (
        <EmptyState
          title={
            scope === 'upcoming'
              ? 'No upcoming bookings'
              : scope === 'past'
                ? 'No past bookings'
                : 'No messages'
          }
          description={
            scope === 'messages'
              ? 'Notes left on the booking page without a time show here.'
              : 'Bookings from the link show here as soon as they are made.'
          }
        />
      ) : (
        <ul className="space-y-2" data-tour="booking-list">
          {list.bookings.map((b) => (
            <BookingCard
              key={b.id}
              booking={b}
              zone={props.hostZone}
              canCancel={props.canCancel && scope === 'upcoming'}
              onCancel={() => setCancelling(b)}
            />
          ))}
        </ul>
      )}

      <CancelDialog
        booking={cancelling}
        zone={props.hostZone}
        onClose={() => setCancelling(null)}
        onDone={() => {
          setCancelling(null);
          setVersion((v) => v + 1);
          router.refresh();
        }}
      />
    </div>
  );
}

function BookingCard({
  booking: b,
  zone,
  canCancel,
  onCancel,
}: {
  booking: TabBooking;
  zone: string;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const status =
    b.status === 'cancelled' && b.cancelledBy === 'calendar'
      ? { label: 'Cancelled in Google', tone: 'neutral' as const }
      : STATUS[b.status];
  const what =
    b.type === 'message'
      ? 'Message'
      : b.type === 'call'
        ? TYPE_LABEL.call
        : `${KIND_LABEL[b.kind ?? 'coffee']}, 1 hour in person`;
  const Icon = b.type === 'call' ? Video : b.type === 'in_person' ? Coffee : MessageSquare;
  const deck = httpsOnly(b.deckUrl);
  const google = httpsOnly(b.eventLink);
  const day = b.startsAt ? dayKeyIn(b.startsAt, zone) : null;
  const theirs =
    b.startsAt && b.visitorTimeZone && b.visitorTimeZone !== zone ? b.visitorTimeZone : null;
  const live = b.status === 'booked' || b.status === 'held' || b.status === 'pending';
  return (
    <li
      aria-label={`Booking with ${b.name}`}
      data-status={b.status}
      className={cn(
        'rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-3',
        !live && b.type !== 'message' && 'opacity-80',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">
              {b.name}
              {b.company ? (
                <span className="font-normal text-[var(--fg-muted)]"> · {b.company}</span>
              ) : null}
            </p>
            <Badge tone={status.tone}>{status.label}</Badge>
            {b.rescheduledCount > 0 ? (
              <Badge tone="outline">
                Moved {b.rescheduledCount === 1 ? 'once' : `${b.rescheduledCount} times`}
              </Badge>
            ) : null}
            {b.source === 'chatbot' ? <Badge tone="neutral">Through the chatbot</Badge> : null}
          </div>
          <p className="text-sm">
            {what}
            {b.startsAt ? (
              <>
                {' · '}
                <span className="font-medium">
                  {slotLabel(b.startsAt, zone)}
                  {b.endsAt ? `–${timeLabel(b.endsAt, zone)}` : ''}
                </span>
                {theirs ? (
                  <span className="text-[var(--fg-muted)]">
                    {' '}
                    ({slotLabel(b.startsAt, theirs)} their time)
                  </span>
                ) : null}
              </>
            ) : null}
          </p>
          {b.type === 'in_person' && b.placeName ? (
            <p className="flex items-center gap-1 text-sm text-[var(--fg-muted)]">
              <MapPin className="size-3.5" aria-hidden="true" />
              {b.placeName}
              {b.placeArea ? `, ${b.placeArea}` : ''}
            </p>
          ) : null}
          <p className="text-sm text-[var(--fg-muted)]">
            <a href={`mailto:${encodeURIComponent(b.email)}`} className="link-inline break-all">
              {b.email}
            </a>
            {' · '}booked {relativeTime(b.createdAt)}
          </p>
          {b.guests.length ? (
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <Users className="size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
              <span className="text-[var(--fg-muted)]">Guests:</span>
              {b.guests.map((g) => (
                <span
                  key={g}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs break-all"
                >
                  {g}
                </span>
              ))}
            </p>
          ) : null}
          {b.note ? (
            <p className="text-read line-clamp-3 rounded-md bg-[var(--bg-sunken)] px-3 py-2 whitespace-pre-line">
              {b.note}
            </p>
          ) : null}
          {b.status === 'cancelled' && b.cancelledBy === 'calendar' ? (
            <p className="text-sm text-[var(--fg-muted)]">
              The event was deleted in Google Calendar, so this time is free again and no longer
              counts toward the day&apos;s cap.
            </p>
          ) : null}
          {b.status === 'cancelled' && b.cancelNote ? (
            <p className="text-sm">
              <span className="text-[var(--fg-muted)]">Their note: </span>
              <span className="whitespace-pre-line">{b.cancelNote}</span>
            </p>
          ) : null}
          {b.status === 'held' ? (
            <p className="text-sm text-[var(--warn)]">
              Held: it goes on the calendar as soon as calendar editing is on.
            </p>
          ) : null}
          {deck ? (
            <p className="text-sm">
              <a
                href={deck}
                target="_blank"
                rel="noopener noreferrer"
                className="link-inline inline-flex items-center gap-1"
              >
                <FileText className="size-3.5" aria-hidden="true" />
                Deck <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </p>
          ) : null}
        </div>
      </div>
      {day || canCancel ? (
        <div className="mt-3 flex flex-wrap gap-2 sm:pl-12">
          {day ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/calendar?view=day&date=${day}`}>
                <CalendarDays aria-hidden="true" />
                Open in Calendar
              </Link>
            </Button>
          ) : null}
          {google ? (
            <Button asChild size="sm" variant="ghost">
              <a href={google} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Google Calendar
              </a>
            </Button>
          ) : null}
          {canCancel && live ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <X aria-hidden="true" />
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CancelDialog({
  booking,
  zone,
  onClose,
  onDone,
}: {
  booking: TabBooking | null;
  zone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const cancel = async () => {
    if (!booking) return;
    setBusy(true);
    setProblem(null);
    const res = await fetch(`/api/booking/bookings/${encodeURIComponent(booking.id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
    }).catch(() => null);
    setBusy(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok) {
      setProblem(json?.error?.message ?? 'It was not cancelled. Try again.');
      return;
    }
    toast.success('Cancelled. Google Calendar tells them.');
    setNote('');
    onDone();
  };
  return (
    <Dialog
      open={booking !== null}
      onOpenChange={(open) => {
        if (!open) {
          setNote('');
          setProblem(null);
          onClose();
        }
      }}
    >
      {booking ? (
        <DialogContent
          title={`Cancel with ${booking.name}?`}
          description={
            booking.startsAt
              ? `${slotLabel(booking.startsAt, zone)}. It comes off the calendar and Google Calendar tells everyone invited.`
              : undefined
          }
        >
          <div className="space-y-1.5">
            <Label htmlFor="cancel-note">Note (optional)</Label>
            <Textarea
              id="cancel-note"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Sorry, something came up."
            />
          </div>
          {problem ? (
            <div role="alert" className="mt-3">
              <Notice tone="warn">{problem}</Notice>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void cancel()}>
              Cancel the booking
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
