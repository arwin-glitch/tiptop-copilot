import { CheckCircle2, ChevronRight, CircleAlert } from 'lucide-react';
import { colorWords } from '@/lib/calendar/colors';
import { byPickerOrder, labelName } from '@/lib/calendar/labels';
import type { EventLabel } from '@/lib/calendar/range-types';
import type { LabelReport } from '@/lib/services/calendar-labels';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';

/**
 * Diagnostics › Event labels: each calendar's colour labels as Google has
 * them right now (name and colour), and how many events in the next seven
 * days carry each, so the live data can be checked without changing
 * anything. A server component: nothing on this tab can change a calendar.
 *
 * Google lists a slot for every colour, named or not. The named labels are
 * listed one by one, in Google's picker order; the colours without a name
 * fold into one "+N colours without a name" line that opens to list them
 * (D-072). The warnings are as before: a calendar without labels, and events
 * pointing at a label the calendar did not list.
 */

/** The same three columns in the table and in the folded rows inside it, so they line up. */
function Columns() {
  return (
    <colgroup>
      <col className="w-1/2" />
      <col className="w-1/4" />
      <col className="w-1/4" />
    </colgroup>
  );
}

/** One label's row: its dot, its name (or its colour's), its colour, its count. */
function LabelRow({ label, count }: { label: EventLabel; count: number }) {
  return (
    <tr>
      <td className="py-1.5">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: label.color.background }}
          />
          {labelName(label) ?? (
            <span className="text-[var(--fg-muted)]">{colorWords(label.color.background)}</span>
          )}
        </span>
      </td>
      <td className="py-1.5 font-mono text-xs text-[var(--fg-muted)]">{label.color.background}</td>
      <td className="py-1.5 text-right tabular-nums">{count}</td>
    </tr>
  );
}

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
              <table className="w-full table-fixed text-sm">
                <Columns />
                <thead>
                  <tr className="text-left text-xs text-[var(--fg-muted)]">
                    <th className="py-1 font-medium">Label</th>
                    <th className="py-1 font-medium">Colour</th>
                    <th className="py-1 text-right font-medium">Events, next 7 days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {byPickerOrder(
                    c.labels
                      .filter(({ label }) => labelName(label) !== null)
                      .map(({ label, count }) => ({ ...label, count })),
                  ).map(({ count, ...label }) => (
                    <LabelRow key={label.id} label={label} count={count} />
                  ))}
                  <UnnamedRows labels={c.labels} />
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
              <div className="space-y-1 text-sm">
                <p className="text-[var(--fg-muted)]">
                  No colour labels: its events take Google&apos;s event colours.
                  {c.read ? ` ${c.unlabelled} events without one in the next 7 days.` : ''}
                </p>
                {c.unknown ? (
                  <p data-label-unread="" className="text-[var(--warn)]">
                    {c.unknown} {c.unknown === 1 ? 'event points' : 'events point'} at a label
                    Google did not list for this calendar: its labels could not be read.
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * The colours without a name, folded into one line ("+14 colours without a
 * name", with how many events carry any of them) that opens to list each.
 */
function UnnamedRows({ labels }: { labels: LabelReport['calendars'][number]['labels'] }) {
  const unnamed = byPickerOrder(
    labels
      .filter(({ label }) => labelName(label) === null)
      .map(({ label, count }) => ({ ...label, count })),
  );
  if (unnamed.length === 0) return null;
  const total = unnamed.reduce((sum, l) => sum + l.count, 0);
  return (
    <tr data-unnamed-labels="">
      <td colSpan={3} className="py-1.5">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[var(--fg-muted)] [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
              />
              <span aria-hidden className="inline-flex -space-x-1">
                {unnamed.slice(0, 5).map((l) => (
                  <span
                    key={l.id}
                    className="size-3 shrink-0 rounded-full border border-[var(--bg-raised)]"
                    style={{ backgroundColor: l.color.background }}
                  />
                ))}
              </span>
              +{unnamed.length} {unnamed.length === 1 ? 'colour' : 'colours'} without a name
            </span>
            <span className="text-[var(--fg)] tabular-nums">{total}</span>
          </summary>
          <table className="mt-1 w-full table-fixed text-sm">
            <Columns />
            <tbody className="divide-y divide-[var(--border)]">
              {unnamed.map(({ count, ...label }) => (
                <LabelRow key={label.id} label={label} count={count} />
              ))}
            </tbody>
          </table>
        </details>
      </td>
    </tr>
  );
}
