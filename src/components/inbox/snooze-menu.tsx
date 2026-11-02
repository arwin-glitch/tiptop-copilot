'use client';

import * as React from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  checkWakeAt,
  pickedWakeAt,
  snoozePresets,
  toDateTimeLocal,
  type SnoozePreset,
} from '@/lib/email/snooze';
import { formatWeekdayTime } from '@/lib/util/time';

const ITEM =
  'flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]';

/** The reader's own zone (the browser's), else the profile's. */
export function readerZone(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Gmail's "Snooze until…": Later today, Tomorrow, This weekend, Next week,
 * or a date and time picked by hand. Worked out in the reader's own zone
 * when it opens, so the times are the ones on their clock. Picking one
 * calls `onSnooze` with the wake instant; the menu changes nothing itself.
 */
export function SnoozeMenu({
  timeZone,
  onSnooze,
  open,
  onOpenChange,
  children,
}: {
  /** The profile's zone, used only when the browser does not say its own. */
  timeZone: string;
  onSnooze: (wakeAt: Date) => void;
  /** Controlled open state, for the `b` key; left out, the menu keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger. */
  children: React.ReactNode;
}) {
  const [ownOpen, setOwnOpen] = React.useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  // Read each time it opens: "Later today" moves with the clock.
  const [opened, setOpened] = React.useState<{ now: Date; zone: string } | null>(null);
  if (isOpen && !opened) setOpened({ now: new Date(), zone: readerZone(timeZone) });
  if (!isOpen && opened) setOpened(null);
  const presets: SnoozePreset[] = opened ? snoozePresets(opened.now, opened.zone) : [];

  const close = () => {
    setOpen(false);
    setPicking(false);
    setPicked('');
    setError(null);
  };
  const choose = (at: Date) => {
    close();
    onSnooze(at);
  };
  const submitPicked = (e: React.FormEvent) => {
    e.preventDefault();
    const zone = opened?.zone ?? readerZone(timeZone);
    const at = pickedWakeAt(picked, zone);
    const check = at
      ? checkWakeAt(at, new Date())
      : { ok: false as const, message: 'Pick a date and time.' };
    if (!check.ok) {
      setError(check.message);
      return;
    }
    choose(check.at);
  };

  return (
    <Popover open={isOpen} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent aria-label="Snooze until" className="w-72">
        <FieldLabel as="p" className="px-1.5 pt-0.5 pb-2">
          Snooze until…
        </FieldLabel>
        <ul className="space-y-0.5">
          {presets.map((p) => (
            <li key={p.id}>
              <button type="button" className={ITEM} onClick={() => choose(p.at)}>
                <span>{p.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">
                  {formatWeekdayTime(p.at, opened?.zone ?? timeZone)}
                </span>
              </button>
            </li>
          ))}
          <li className="border-t border-[var(--border)] pt-1">
            {picking ? (
              <form onSubmit={submitPicked} className="space-y-2 px-1.5 py-1">
                <label htmlFor={`${id}-at`} className="sr-only">
                  Snooze until date and time
                </label>
                <input
                  id={`${id}-at`}
                  type="datetime-local"
                  autoFocus
                  required
                  value={picked}
                  min={opened ? toDateTimeLocal(opened.now, opened.zone) : undefined}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    setError(null);
                  }}
                  className="h-8 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm text-[var(--fg)]"
                />
                {error ? (
                  <p role="alert" className="text-xs text-[var(--danger)]">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPicking(false)}>
                    Back
                  </Button>
                  <Button type="submit" size="sm">
                    Snooze
                  </Button>
                </div>
              </form>
            ) : (
              <button type="button" className={ITEM} onClick={() => setPicking(true)}>
                <span className="flex items-center gap-2">
                  <CalendarClock className="size-4 text-[var(--fg-muted)]" aria-hidden />
                  Pick date &amp; time
                </span>
              </button>
            )}
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
