import Link from 'next/link';
import { AlarmClock, CalendarCheck, Hourglass } from 'lucide-react';
import { cadenceLabel, dueLabel, recordPath, type CadenceState } from '@/lib/crm/cadence';
import type { KeepInTouchRow } from '@/lib/services/keep-in-touch';
import { formatDate } from '@/lib/util/time';
import { STATE_TONE } from '@/components/network/keep-in-touch-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const GROUPS: { state: CadenceState; title: string; icon: React.ReactNode; empty: string }[] = [
  {
    state: 'overdue',
    title: 'Overdue',
    icon: <AlarmClock className="size-4 text-[var(--danger)]" aria-hidden />,
    empty: 'Nobody is overdue.',
  },
  {
    state: 'due_soon',
    title: 'Due soon',
    icon: <Hourglass className="size-4 text-[var(--warn)]" aria-hidden />,
    empty: 'Nobody is due in the next few days.',
  },
  {
    state: 'on_track',
    title: 'On track',
    icon: <CalendarCheck className="size-4 text-[var(--ok)]" aria-hidden />,
    empty: 'Nobody else has a cadence.',
  },
];

const KIND_WORDS = {
  inbound: 'email from them',
  outbound: 'email to them',
  meeting: 'meeting',
} as const;

/**
 * Everyone with a keep-in-touch cadence, overdue first, each with the last
 * contact the due date is counted from. A due one also has a "Check in with"
 * task on Tasks; this list is where the cadences themselves are seen.
 */
export function KeepInTouchList({ rows, timezone }: { rows: KeepInTouchRow[]; timezone: string }) {
  return (
    <Card role="region" aria-label="Keep in touch">
      <CardHeader>
        <div>
          <CardTitle as="h2">Keep in touch</CardTitle>
          <CardDescription>
            Cadences set on profiles. Due dates count from the last email or meeting in your own
            mail and calendar, or the last check-in task you closed.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        {GROUPS.map((group) => {
          const items = rows.filter((r) => r.status.state === group.state);
          return (
            <section key={group.state} aria-labelledby={`keep-${group.state}`}>
              <h3
                id={`keep-${group.state}`}
                className="mb-2 flex items-center gap-1.5 text-sm font-semibold"
              >
                {group.icon}
                {group.title}
                <span className="tabular text-xs font-normal text-[var(--fg-subtle)]">
                  {items.length}
                </span>
              </h3>
              {items.length === 0 ? (
                <p className="text-sm text-[var(--fg-subtle)]">{group.empty}</p>
              ) : (
                <ul className="space-y-3">
                  {items.map((row) => (
                    <li key={row.record.id} className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={recordPath(row.record.id)}
                          className="text-sm font-medium underline-offset-2 hover:underline"
                        >
                          {row.record.name}
                        </Link>
                        <Badge tone={STATE_TONE[row.status.state]}>{dueLabel(row.status)}</Badge>
                      </div>
                      <p className="text-xs text-[var(--fg-subtle)]">
                        {cadenceLabel(row.cadence.days)} · next{' '}
                        {formatDate(row.status.dueAt, timezone)}
                      </p>
                      <p className="text-xs text-[var(--fg-subtle)]">
                        {row.evidence.lastContactAt && row.evidence.lastContactKind
                          ? `Last ${KIND_WORDS[row.evidence.lastContactKind]} ${formatDate(row.evidence.lastContactAt, timezone)}`
                          : 'No contact on record'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
