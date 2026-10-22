'use client';

import * as React from 'react';
import { dayKeyIn, type PublicDay, type PublicSlot } from '@/lib/booking/public';
import { BookingCalendar, defaultDay, TimeGrid } from './month-calendar';

/**
 * The booking link's time picker for moving a booking (D-074, D-078): the
 * same month calendar as the booking page (one month at a time, its arrows
 * only to months with open times), then the picked day's times as buttons
 * ("Time"), in the visitor's zone. So a visitor sees the same picker in both
 * places, and a link open for months is never a wall of day chips.
 */
export function SlotPicker({
  slots,
  zone,
  value,
  onChange,
  day,
  onDay,
  days,
  months,
  label = 'Open days',
}: {
  slots: readonly PublicSlot[];
  zone: string;
  /** The start picked, or null. */
  value: string | null;
  onChange: (start: string | null) => void;
  /** The day shown when no time is picked yet (a key in `zone`), or null for the first. */
  day: string | null;
  onDay: (day: string) => void;
  days?: readonly PublicDay[];
  months?: readonly string[];
  label?: string;
}) {
  const [month, setMonth] = React.useState<string | null>(null);
  const today = React.useMemo(() => dayKeyIn(new Date().toISOString(), zone), [zone]);
  const shownDay = defaultDay({ slots, zone, value, day, month });
  return (
    <div className="space-y-4">
      <BookingCalendar
        slots={slots}
        days={days}
        months={months}
        zone={zone}
        today={today}
        month={month ?? (shownDay ? shownDay.slice(0, 7) : null)}
        onMonth={(next) => {
          setMonth(next);
          if (value && dayKeyIn(value, zone).slice(0, 7) !== next) onChange(null);
          const first = defaultDay({ slots, zone, value: null, day: null, month: next });
          if (first) onDay(first);
        }}
        selected={shownDay}
        onSelect={(key) => {
          onDay(key);
          setMonth(key.slice(0, 7));
          if (value && dayKeyIn(value, zone) !== key) onChange(null);
        }}
        label={label}
      />
      <TimeGrid
        slots={slots}
        zone={zone}
        day={shownDay}
        value={value}
        onChange={(start) => onChange(start)}
      />
    </div>
  );
}
