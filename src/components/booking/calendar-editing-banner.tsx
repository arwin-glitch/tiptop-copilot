import { AlertTriangle } from 'lucide-react';
import { TURN_ON_EDITING_HREF } from '@/components/today/booking-requests-line';

/**
 * The banner for Copilot's Booking tab (D-078) while calendar editing is
 * off: bookings from the link are held, not on the calendar, until it is
 * turned on, and then they go on by themselves (each checked again). Shown
 * only while editing is off; it says how many times are held.
 */
export function CalendarEditingBanner({
  calendarEditing,
  held,
}: {
  calendarEditing: boolean;
  held: number;
}) {
  if (calendarEditing) return null;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-card)] border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--fg)]"
    >
      <AlertTriangle className="size-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">
          Turn on calendar editing so invites go out automatically.
        </strong>{' '}
        {held
          ? `${held} ${held === 1 ? 'booking is' : 'bookings are'} held until then; they go on the calendar by themselves once it is on.`
          : 'Until then, new bookings are held and go on the calendar by themselves once it is on.'}
      </p>
      <a
        href={TURN_ON_EDITING_HREF}
        className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
      >
        Turn on calendar editing
      </a>
    </div>
  );
}
