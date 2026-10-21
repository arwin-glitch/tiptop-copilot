import { CheckCircle2, CircleAlert, CircleDashed, CircleOff, Clock3 } from 'lucide-react';
import { STATUS_LABEL, type FeedStatus } from '@/lib/feeds/status';
import { feedReportAllClear, feedReportHeadline, feedRowSummary } from '@/lib/feeds/words';
import type { FeedReport, FeedRow } from '@/lib/services/feed-health';
import { relativeTime } from '@/lib/util/time';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';

/**
 * Diagnostics > Feeds: every feed that fills a card, worst first, with when
 * it was last seen and what was expected, in plain words. Plain text only:
 * nothing here comes from a post's content.
 */

const TONE: Record<FeedStatus, NonNullable<BadgeProps['tone']>> = {
  ok: 'ok',
  late: 'warn',
  stopped: 'danger',
  never: 'neutral',
  unknown: 'neutral',
  off: 'outline',
};

function StatusIcon({ status }: { status: FeedStatus }) {
  const className = 'mt-0.5 size-4 shrink-0';
  switch (status) {
    case 'ok':
      return <CheckCircle2 className={`${className} text-[var(--ok)]`} aria-hidden="true" />;
    case 'late':
      return <Clock3 className={`${className} text-[var(--warn)]`} aria-hidden="true" />;
    case 'stopped':
      return <CircleAlert className={`${className} text-[var(--danger)]`} aria-hidden="true" />;
    case 'off':
      return <CircleOff className={`${className} text-[var(--fg-subtle)]`} aria-hidden="true" />;
    default:
      return <CircleDashed className={`${className} text-[var(--fg-subtle)]`} aria-hidden="true" />;
  }
}

function FeedLine({ row, now, timeZone }: { row: FeedRow; now: Date; timeZone: string }) {
  return (
    <li className="flex items-start gap-3 py-3" data-feed={row.id} data-status={row.status}>
      <StatusIcon status={row.status} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {row.def.name}
          <Badge tone={TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        </p>
        <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
          {feedRowSummary(row, now, timeZone)}
        </p>
        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
          {row.def.schedule} · Fills {row.def.fills.join(', ')}
        </p>
      </div>
    </li>
  );
}

export function FeedHealthList({
  report,
  now,
  timeZone,
}: {
  report: FeedReport;
  now: Date;
  timeZone: string;
}) {
  const headline = feedReportHeadline(report.rows);
  return (
    <div className="space-y-4">
      {headline ? (
        <Notice tone="warn">
          <p className="font-medium">{headline}</p>
          <p className="mt-1 text-[var(--fg-muted)]">
            Their cards keep showing the last copy that arrived. The routine or job itself has to be
            looked at; nothing here restarts it.
          </p>
        </Notice>
      ) : (
        <Notice>{feedReportAllClear(report.rows)}</Notice>
      )}
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">Feeds</CardTitle>
            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
              Checked {relativeTime(report.checkedAt, now)}. A feed that only posts when there is
              something new is never late.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--border)]" aria-label="Feeds">
            {report.rows.map((row) => (
              <FeedLine key={row.id} row={row} now={now} timeZone={timeZone} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
