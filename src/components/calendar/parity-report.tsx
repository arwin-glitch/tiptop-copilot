import { CheckCircle2, CircleAlert } from 'lucide-react';
import type { ParityDifference, ParityReport } from '@/lib/calendar/parity';
import { PARITY_MAX_DAYS } from '@/lib/calendar/parity';
import { formatTime } from '@/lib/util/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/form';
import { Notice } from '@/components/ui/feedback';

/**
 * Diagnostics › Event parity: the day list and the new calendar views, side
 * by side for the main calendar, one row per difference. A server component:
 * the form is a plain GET, and nothing on this tab can change a calendar.
 */

const KIND: Record<ParityDifference['kind'], { label: string; tone: 'warn' | 'danger' | 'info' }> =
  {
    missing: { label: 'Missing from the new views', tone: 'danger' },
    extra: { label: 'Only in the new views', tone: 'warn' },
    changed: { label: 'Shown differently', tone: 'info' },
  };

function dayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

export function ParityForm({ from, days }: { from: string; days: number }) {
  return (
    <form method="get" action="/diagnostics" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="tab" value="parity" />
      <div className="space-y-1">
        <Label htmlFor="parity-from">From</Label>
        <Input id="parity-from" type="date" name="from" defaultValue={from} className="w-44" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="parity-days">Days</Label>
        <Select id="parity-days" name="days" defaultValue={String(days)} className="w-28">
          {[1, 7, 14, PARITY_MAX_DAYS].map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'day' : 'days'}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="primary">
        Check
      </Button>
    </form>
  );
}

export function ParityResult({ report }: { report: ParityReport }) {
  if (report.state === 'not_connected') {
    return (
      <Notice tone="warn">
        No calendar is connected. Connect Google in Settings › Integrations.
      </Notice>
    );
  }
  if (report.state === 'error') {
    return (
      <Notice tone="warn">{report.message ?? 'Google Calendar did not answer. Try again.'}</Notice>
    );
  }
  const { totals } = report;
  const clean = totals.differences === 0 && totals.failedDays === 0;
  const withDifferences = report.dayReports.filter(
    (d) => d.differences.length || d.state === 'error',
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-start gap-3 py-4">
          {clean ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[var(--ok)]" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-[var(--warn)]" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {clean
                ? `They match: all ${totals.current} ${totals.current === 1 ? 'event' : 'events'} over ${report.days} ${report.days === 1 ? 'day' : 'days'} are the same in both.`
                : `${totals.differences} ${totals.differences === 1 ? 'difference' : 'differences'}${totals.failedDays ? `, ${totals.failedDays} ${totals.failedDays === 1 ? 'day' : 'days'} not read` : ''}.`}
            </p>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              {report.calendarName ? `${report.calendarName}, ` : ''}
              {dayLabel(report.from)} for {report.days} {report.days === 1 ? 'day' : 'days'} · day
              list {totals.current} · new views {totals.next} · matched {totals.matched}
            </p>
          </div>
          <Badge tone={clean ? 'ok' : 'warn'}>{clean ? 'Parity' : 'Not yet'}</Badge>
        </CardContent>
      </Card>

      {withDifferences.length ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Differences</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[var(--border)]">
              {withDifferences.map((day) => (
                <li key={day.dateKey} className="py-3">
                  <p className="mb-1.5 text-sm font-medium">{dayLabel(day.dateKey)}</p>
                  {day.state === 'error' ? (
                    <p className="text-sm text-[var(--danger)]">
                      The day list could not read it: {day.message}
                    </p>
                  ) : null}
                  <ul className="space-y-1.5">
                    {day.differences.map((d) => (
                      <li key={`${d.kind}-${d.id}`} className="text-sm">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={KIND[d.kind].tone}>{KIND[d.kind].label}</Badge>
                          <span className="text-[var(--fg-muted)] tabular-nums">
                            {d.startsAt ? formatTime(d.startsAt, report.timeZone) : 'All day'}
                          </span>
                          <span className="min-w-0 break-words">{d.title}</span>
                        </span>
                        {d.fields.length ? (
                          <ul className="mt-0.5 pl-3 text-xs text-[var(--fg-muted)]">
                            {d.fields.map((f) => (
                              <li key={f.field}>
                                {f.field}: day list “{f.current}” · new views “{f.next}”
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
