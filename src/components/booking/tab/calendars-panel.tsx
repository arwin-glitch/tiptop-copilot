'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Notice, Skeleton } from '@/components/ui/feedback';
import { Switch } from '@/components/ui/form';
import { chooseCalendar } from '@/lib/booking/calendar-choices';
import type { CalendarChoice } from '@/lib/booking/config';
import { useSettingsSave } from './hooks';

interface CalendarRow {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  owner: boolean;
  selectedInGoogle: boolean;
  shownInCopilot: boolean;
  lock: 'main' | 'teammate' | null;
  defaultCounts: boolean;
  counts: boolean;
}

/**
 * Calendars: which of the host's calendars block his time on the booking
 * link. By default his main one, his own (personal, family) and the ones
 * ticked in Google; any other can be switched on or off here. His main
 * calendar always counts, and a teammate's own calendar never does. Each
 * switch saves at once.
 */
export function CalendarsPanel({
  choices: initialChoices,
  canEdit,
}: {
  choices: CalendarChoice[];
  canEdit: boolean;
}) {
  const { save, saving } = useSettingsSave();
  const [rows, setRows] = React.useState<CalendarRow[] | null>(null);
  const [shown, setShown] = React.useState<Record<string, boolean>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [choices, setChoices] = React.useState<CalendarChoice[]>(initialChoices);

  React.useEffect(() => {
    let live = true;
    void fetch('/api/booking/calendars', { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          calendars?: CalendarRow[];
          shown?: Record<string, boolean>;
          error?: { message?: string };
        } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.calendars) {
          setError(json?.error?.message ?? 'The calendars did not load.');
          return;
        }
        setRows(json.calendars);
        setShown(json.shown ?? {});
      })
      .catch(() => {
        if (live) setError('The calendars did not load.');
      });
    return () => {
      live = false;
    };
  }, []);

  const flip = async (row: CalendarRow, counts: boolean) => {
    const next = chooseCalendar(
      choices,
      {
        id: row.id,
        primary: row.primary,
        accessRole: row.owner ? 'owner' : 'reader',
        selectedInGoogle: row.selectedInGoogle,
      },
      counts,
      shown,
    );
    const before = { rows, choices };
    setChoices(next);
    setRows((list) => list?.map((r) => (r.id === row.id ? { ...r, counts } : r)) ?? null);
    const saved = await save(
      { config: { calendarChoices: next } },
      counts ? `${row.name} now blocks his time` : `${row.name} no longer blocks his time`,
    );
    if (!saved) {
      setChoices(before.choices);
      setRows(before.rows);
    }
  };

  return (
    <div className="space-y-4" data-tour="booking-calendars">
      <p className="text-sm text-[var(--fg-muted)]">
        A busy entry on any switched-on calendar makes that time busy on the booking link. Entries
        marked free, like most holidays, do not: close those days in Availability. Visitors never
        see titles, guests or calendar names: only free times.
      </p>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      {!rows && !error ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}
      {rows ? (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-panel)] border border-[var(--border)]">
          {rows.map((row) => {
            const note =
              row.lock === 'main'
                ? 'His main calendar: always counts.'
                : row.lock === 'teammate'
                  ? 'Teammate: never counts.'
                  : row.owner
                    ? 'His own calendar.'
                    : row.selectedInGoogle
                      ? 'Ticked in Google Calendar.'
                      : row.shownInCopilot
                        ? 'Shown in Kraken’s Calendar tab.'
                        : 'Shared with him.';
            return (
              <li
                key={row.id}
                data-calendar={row.name}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
              >
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">{row.name}</p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {note}
                    {row.lock === null && row.counts !== row.defaultCounts ? ' Changed here.' : ''}
                  </p>
                </div>
                {row.lock === 'teammate' ? (
                  <Badge tone="outline">Teammate · never counts</Badge>
                ) : null}
                {row.lock ? (
                  <Lock className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
                ) : null}
                <Switch
                  checked={row.counts}
                  disabled={!canEdit || saving || row.lock !== null}
                  aria-label={`${row.name} blocks his time`}
                  onCheckedChange={(v) => void flip(row, v)}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      {!canEdit ? <Notice>Only an admin or the owner can change this.</Notice> : null}
    </div>
  );
}
