import 'server-only';
import { KIND_LABEL } from '@/lib/booking/config';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import type { BookingRequest } from '@/lib/types/domain';

/**
 * What the host hears about the booking link (D-078), through Copilot's own
 * alert feed (the phone and desktop alerts, lib/services/push-alerts.ts),
 * the Booking tab and a Today line, never by email: a new booking, a move,
 * a cancellation with the visitor's note, and a held time released because
 * it was taken. Worked out from the bookings themselves, so nothing is
 * queued: each change has its own ledger key and alerts once.
 *
 * A change made in Copilot (a cancel from the Booking tab) or in Google
 * Calendar (an event deleted there) is the team's own doing and does not
 * alert.
 */

/** How far back a change still alerts (quiet hours push the night's to the morning). */
export const BOOKING_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BookingAlertKind = 'new' | 'moved' | 'cancelled' | 'released';

export interface BookingAlertItem {
  /** Ledger key: `booking:<id>:<change>`. */
  key: string;
  kind: BookingAlertKind;
  /** One plain line: `Pat Lee cancelled Tue 27 Oct 4:30 PM: "Something came up"`. */
  line: string;
}

/** "Tue 27 Oct 4:30 PM", in the host's zone. */
export function alertTime(iso: string, timeZone: string): string {
  const at = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(at);
    } catch {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(at);
    }
  };
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })} ${part({ hour: 'numeric', minute: '2-digit' })}`;
}

function what(row: BookingRequest): string {
  if (row.meeting_type === 'call') return 'a 30-minute call';
  const kind = row.kind ? KIND_LABEL[row.kind].toLowerCase() : 'an hour in person';
  return row.place_name ? `${kind} at ${row.place_name}` : kind;
}

const recent = (iso: string | null | undefined, now: Date) => {
  const at = Date.parse(iso ?? '');
  // A minute of clock skew either way still counts as just now.
  return Number.isFinite(at) && at <= now.getTime() + 60_000 && now.getTime() - at <= BOOKING_ALERT_WINDOW_MS;
};

/** Clip a visitor's note for a notification line. */
function clipNote(note: string): string {
  const flat = note.replace(/\s+/g, ' ').trim();
  return flat.length <= 140 ? flat : `${flat.slice(0, 139).trimEnd()}…`;
}

/**
 * The changes that alert, from the link's rows. Pure, for tests: a booking
 * made at once, held or waiting for approval (new); moved by the visitor
 * (once per move); cancelled by the visitor (with the note); a held time
 * released because it was taken.
 */
export function bookingAlertItems(
  rows: readonly BookingRequest[],
  now: Date,
  timeZone: string,
): BookingAlertItem[] {
  const out: BookingAlertItem[] = [];
  for (const row of rows) {
    if (row.meeting_type === 'message' || !row.starts_at) continue;
    const who = row.company ? `${row.name} (${row.company})` : row.name;
    const when = alertTime(row.starts_at, timeZone);
    const guests = row.guest_emails?.length ?? 0;
    const plus = guests ? ` (+${guests} guest${guests === 1 ? '' : 's'})` : '';
    if (recent(row.created_at, now) && ['booked', 'held', 'pending', 'approved', 'cancelled'].includes(row.status)) {
      const verb =
        row.status === 'pending'
          ? 'asked for'
          : row.status === 'held'
            ? 'held (calendar editing is off)'
            : 'booked';
      out.push({
        key: `booking:${row.id}:new`,
        kind: 'new',
        line: `${who} ${verb} ${what(row)}, ${when}${plus}`,
      });
    }
    const moves = row.rescheduled_count ?? 0;
    if (moves > 0 && row.previous_starts_at && recent(row.updated_at, now) && row.status !== 'cancelled') {
      out.push({
        key: `booking:${row.id}:moved:${moves}`,
        kind: 'moved',
        line: `${who} moved ${what(row)} to ${when} (was ${alertTime(row.previous_starts_at, timeZone)})`,
      });
    }
    if (row.status === 'cancelled' && row.cancelled_by === 'visitor' && recent(row.cancelled_at, now)) {
      const note = row.cancel_note?.trim();
      out.push({
        key: `booking:${row.id}:cancelled`,
        kind: 'cancelled',
        line: `${who} cancelled ${when}${note ? `: "${clipNote(note)}"` : ''}`,
      });
    }
    if (
      row.status === 'declined' &&
      row.decided_by === null &&
      row.manage_token_hash &&
      recent(row.decided_at, now)
    ) {
      out.push({
        key: `booking:${row.id}:released`,
        kind: 'released',
        line: `The time held for ${who} (${when}) was taken before it could be booked: a notice is ready to send`,
      });
    }
  }
  return out;
}

/**
 * The link's rows that changed in the alert window, for bookingAlertItems.
 * Never throws: without the tables (or the v2 columns) there is nothing to say.
 */
export async function readBookingAlertItems(
  store: DataStore,
  organizationId: string,
  now: Date,
  timeZone: string,
): Promise<BookingAlertItem[]> {
  try {
    const rows = await store.list(
      'booking_requests',
      organizationId,
      {
        neq: { meeting_type: 'message' },
        gte: { updated_at: new Date(now.getTime() - BOOKING_ALERT_WINDOW_MS).toISOString() },
      },
      { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: 200 },
    );
    return bookingAlertItems(rows, now, timeZone);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return [];
    return [];
  }
}

export interface BookingTodaySummary {
  /** Requests waiting for approval (approve first) and messages. */
  waiting: number;
  /** Held times waiting for calendar editing. */
  held: number;
  /** In the last day: booked, moved and cancelled by visitors. */
  booked: number;
  moved: number;
  cancelled: number;
  /** The latest visitor cancellation note, clipped, for the line. */
  latestNote: string | null;
}

/** Today's booking line, from the same rows. Never throws: a fault is null and no line. */
export async function bookingTodaySummary(
  store: DataStore,
  organizationId: string,
  now: Date,
  timeZone: string,
): Promise<BookingTodaySummary | null> {
  try {
    const [messages, meetings, held] = await Promise.all([
      store.count('booking_requests', organizationId, {
        eq: { status: 'pending', meeting_type: 'message' },
      }),
      store.count('booking_requests', organizationId, {
        eq: { status: 'pending' },
        neq: { meeting_type: 'message' },
        gte: { starts_at: now.toISOString() },
      }),
      store.count('booking_requests', organizationId, {
        eq: { status: 'held' },
        gte: { starts_at: now.toISOString() },
      }),
    ]);
    const items = await readBookingAlertItems(store, organizationId, now, timeZone);
    const cancelled = items.filter((i) => i.kind === 'cancelled');
    const note = cancelled.find((i) => i.line.includes(': "'));
    return {
      waiting: messages + meetings,
      held,
      booked: items.filter((i) => i.kind === 'new').length,
      moved: items.filter((i) => i.kind === 'moved').length,
      cancelled: cancelled.length,
      latestNote: note ? note.line : null,
    };
  } catch {
    return null;
  }
}
