import { CheckCircle2, CircleAlert } from 'lucide-react';
import { labelText } from '@/lib/calendar/labels';
import type { LabelReport } from '@/lib/services/calendar-labels';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';

/**
 * Diagnostics › Event labels: each calendar's colour labels as Google has
 * them right now (name and colour), and how many events in the next seven
 * days carry each, so the live data can be checked without changing
 * anything. A server component: nothing on this tab can change a calendar.
 */

function dayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

export function LabelReportView({ report }: { report: LabelReport }) {
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
  const withLabels = report.calendars.filter((c) => c.labels.length > 0);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-start gap-3 py-4">
          {withLabels.length ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[var(--ok)]" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-[var(--warn)]" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {withLabels.length
                ? `${withLabels.length} of ${report.calendars.length} calendars have colour labels.`
                : 'No calendar on the list has colour labels.'}
            </p>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              Events counted from {dayLabel(report.from)} for 7 days. Read live from Google Calendar
              just now; nothing is stored or changed.
            </p>
          </div>
        </CardContent>
      </Card>
      {report.calendars.map((c) => (
        <Card key={c.id} data-label-calendar={c.name}>
          <CardHeader>
            <CardTitle as="h2">
              <span className="flex flex-wrap items-center gap-2">
                {c.name}
                {c.primary ? <Badge tone="outline">Main</Badge> : null}
                {!c.read ? <Badge tone="warn">Events not read</Badge> : null}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {c.labels.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--fg-muted)]">
                    <th className="py-1 font-medium">Label</th>
                    <th className="py-1 font-medium">Colour</th>
                    <th className="py-1 text-right font-medium">Events, next 7 days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {c.labels.map(({ label, count }) => (
                    <tr key={label.id}>
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="size-3 shrink-0 rounded-full"
                            style={{ backgroundColor: label.color.background }}
                          />
                          {labelText(label)}
                        </span>
                      </td>
                      <td className="py-1.5 font-mono text-xs text-[var(--fg-muted)]">
                        {label.color.background}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{count}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 text-[var(--fg-muted)]">No label</td>
                    <td />
                    <td className="py-1.5 text-right tabular-nums">{c.unlabelled}</td>
                  </tr>
                  {c.unknown ? (
                    <tr>
                      <td className="py-1.5 text-[var(--warn)]">
                        A label this calendar no longer has
                      </td>
                      <td />
                      <td className="py-1.5 text-right tabular-nums">{c.unknown}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-[var(--fg-muted)]">
                No colour labels: its events take Google&apos;s event colours.
                {c.read ? ` ${c.unlabelled} events in the next 7 days.` : ''}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
