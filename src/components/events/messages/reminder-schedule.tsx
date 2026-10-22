'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { eventsApi } from '@/components/events/events-client';
import {
  MAX_REMINDER_OFFSETS,
  REMINDER_OFFSET_CHOICES,
  cleanOffsets,
  offsetLabel,
} from '@/lib/events/tab-view';

/**
 * When reminder drafts fall due, per session: 1 week, 1 day and 3 hours
 * before by default, any of the quick picks, six at most. Saving changes the
 * schedule only; each reminder is still a draft someone sends.
 */
export function ReminderSchedule({ eventId, offsets }: { eventId: string; offsets: number[] }) {
  const router = useRouter();
  const [chosen, setChosen] = React.useState<number[]>(offsets);
  const [busy, setBusy] = React.useState(false);
  const dirty = chosen.join(',') !== offsets.join(',');
  const available = REMINDER_OFFSET_CHOICES.filter((o) => !chosen.includes(o));

  const save = async () => {
    const clean = cleanOffsets(chosen);
    if (!clean) {
      toast.error('Reminders go 1 minute to 60 days before, six at most.');
      return;
    }
    setBusy(true);
    const result = await eventsApi.messageSettings(eventId, { reminderOffsetsMinutes: clean });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(clean.length ? 'Reminder schedule saved.' : 'Reminders turned off.');
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-1.5" aria-label="Reminders before each session">
        {chosen.length ? (
          chosen.map((o) => (
            <li
              key={o}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-raised)] py-0.5 pr-1 pl-2.5 text-sm"
            >
              {offsetLabel(o)}
              <button
                type="button"
                onClick={() => setChosen(chosen.filter((x) => x !== o))}
                aria-label={`Remove the reminder ${offsetLabel(o)}`}
                className="rounded-full p-0.5 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))
        ) : (
          <li className="text-sm text-[var(--fg-muted)]">No reminders.</li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {available.length && chosen.length < MAX_REMINDER_OFFSETS ? (
          <>
            <label htmlFor="reminder-add" className="sr-only">
              Add a reminder
            </label>
            <Select
              id="reminder-add"
              value=""
              className="w-auto"
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value) setChosen([...chosen, value].sort((a, b) => b - a));
              }}
            >
              <option value="">Add a reminder…</option>
              {available.map((o) => (
                <option key={o} value={o}>
                  {offsetLabel(o)}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!dirty}
          loading={busy}
          onClick={() => void save()}
        >
          Save schedule
        </Button>
      </div>
    </div>
  );
}
