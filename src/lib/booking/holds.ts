import type { BookingHoldReason } from '@/lib/types/domain';

/**
 * A held booking (D-078): booked at once by a visitor, its time kept, but
 * not on the host's calendar yet. Nobody approves it. Copilot puts it on the
 * calendar by itself: at once when calendar editing comes on (checked on
 * every pass, it costs nothing), and after a Google fault on a backoff of
 * about 1, 5, 15 and 60 minutes, then on every pass (the alerts job ticks
 * every minute, and every Copilot or booking page visit runs one too), until
 * it is booked, or released when the time is truly no longer free. Pure and
 * client-safe: the Booking tab shows the same words.
 */

/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed try; after that, every pass. */
export const HOLD_RETRY_MINUTES = [1, 5, 15, 60] as const;

/** How long to wait before the next try, after `attempts` failed tries (0 = every pass). */
export function holdRetryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const minutes = HOLD_RETRY_MINUTES[attempts - 1];
  return minutes === undefined ? 0 : minutes * 60_000;
}

/** When the next try is due after `attempts` failed tries, or null for "every pass". */
export function holdNextTryAt(attempts: number, now: Date): string | null {
  const delay = holdRetryDelayMs(attempts);
  return delay > 0 ? new Date(now.getTime() + delay).toISOString() : null;
}

/** Whether a held booking may be tried on this pass. */
export function holdDue(
  row: { hold_reason?: BookingHoldReason | null; hold_next_try_at?: string | null },
  now: Date,
): boolean {
  if (!row.hold_next_try_at) return true;
  const at = Date.parse(row.hold_next_try_at);
  return !Number.isFinite(at) || at <= now.getTime();
}

/** Why a calendar write failed, as a hold reason: Google not answering, or another fault. */
export function holdReasonForError(code: string): BookingHoldReason {
  return code === 'timeout' || code === 'provider_unavailable' || code === 'rate_limited'
    ? 'calendar_unreachable'
    : 'calendar_error';
}

/** The Booking tab's line for a held booking: what it is waiting for, in plain words. */
export const HOLD_REASON_TEXT: Record<BookingHoldReason, string> = {
  calendar_editing_off: 'Waiting for calendar editing. It books itself the moment that is on.',
  no_main_calendar: 'Copilot cannot write to the main calendar yet. It keeps trying by itself.',
  calendar_unreachable: 'Google Calendar did not answer. Copilot tries again by itself.',
  calendar_error: 'Google Calendar refused the event. Copilot tries again by itself.',
};

export const BOOKING_HOLD_REASONS = [
  'calendar_editing_off',
  'no_main_calendar',
  'calendar_unreachable',
  'calendar_error',
] as const satisfies readonly BookingHoldReason[];
