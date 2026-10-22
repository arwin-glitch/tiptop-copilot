import Link from 'next/link';
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Stat } from '@/components/ui/stat';
import { cn } from '@/lib/util/cn';
import type { EventPanelProps } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { eventOverview } from '@/lib/services/event-overview';

function fixHref(eventId: string, tab: string): string {
  return tab === 'studio' ? `/events/${eventId}/studio` : `/events/${eventId}?tab=${tab}`;
}

/**
 * Overview: is the event ready (the checklist), what to do next, and the
 * headcount, on one screen. A server component; reads only.
 */
export async function OverviewPanel({ event, sessions, viewer }: EventPanelProps) {
  const view = await eventOverview(getStore(), viewer.organizationId, event, sessions);
  const pct = view.checklist.length ? Math.round((view.ready / view.checklist.length) * 100) : 0;
  return (
    <div data-panel="overview" className="grid gap-4 lg:grid-cols-2">
      <Card aria-labelledby="overview-ready-title">
        <CardHeader>
          <div className="min-w-0 flex-1">
            <CardTitle as="h2" id="overview-ready-title">
              Ready
            </CardTitle>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              {view.ready} of {view.checklist.length} done
            </p>
            <div
              role="progressbar"
              aria-label="Ready checklist"
              aria-valuemin={0}
              aria-valuemax={view.checklist.length}
              aria-valuenow={view.ready}
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
            >
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--border)]">
            {view.checklist.map((item) => (
              <li key={item.key} className="flex items-start gap-3 py-2.5">
                {item.done ? (
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-[var(--ok)]"
                    aria-label="Done"
                  />
                ) : (
                  <Circle
                    className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]"
                    aria-label="To do"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm font-medium', item.done && 'text-[var(--fg-muted)]')}>
                    {item.label}
                  </p>
                  <p className="text-sm text-[var(--fg-muted)]">{item.detail}</p>
                </div>
                {!item.done ? (
                  <Link
                    href={fixHref(event.id, item.tab)}
                    className="link-inline shrink-0 text-sm"
                    aria-label={`${item.label}: open`}
                  >
                    Open
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card aria-labelledby="overview-next-title">
          <CardHeader>
            <CardTitle as="h2" id="overview-next-title">
              Next
            </CardTitle>
          </CardHeader>
          <CardContent>
            {view.actions.length ? (
              <ul className="space-y-1.5">
                {view.actions.map((action) => (
                  <li key={action.key}>
                    <Link
                      href={action.href}
                      className={cn(
                        'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-hover)]',
                        action.urgent && 'font-medium',
                      )}
                    >
                      <ArrowRight
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          action.urgent ? 'text-[var(--gold)]' : 'text-[var(--fg-subtle)]',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">{action.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-[var(--fg-muted)]">Nothing needs you on this event.</p>
            )}
          </CardContent>
        </Card>

        <Card aria-labelledby="overview-headcount-title">
          <CardHeader>
            <CardTitle as="h2" id="overview-headcount-title">
              Headcount
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              <Stat size="sm" label="Going" value={view.counts.going} />
              <Stat size="sm" label="Pending" value={view.counts.pending} />
              <Stat size="sm" label="Waitlist" value={view.counts.waitlist} />
              <Stat size="sm" label="No reply" value={view.counts.invited} />
              <Stat size="sm" label="Checked in" value={view.counts.checkedIn} />
            </div>
            {view.headcounts.length ? (
              <ul className="space-y-2.5" aria-label="Going per session">
                {view.headcounts.map((s) => {
                  const fill = s.capacity
                    ? Math.min(100, Math.round((s.going / s.capacity) * 100))
                    : 0;
                  return (
                    <li key={s.id}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate font-medium">{s.name}</span>
                        <span className="tabular shrink-0 text-[var(--fg-muted)]">
                          {s.going} going{s.capacity ? ` of ${s.capacity}` : ''}
                          {s.checkedIn ? ` · ${s.checkedIn} in` : ''}
                        </span>
                      </div>
                      {s.capacity ? (
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                          <div
                            className="h-full rounded-full bg-[var(--accent)]"
                            style={{ width: `${fill}%` }}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {view.counts.plusOnes ? (
              <p className="text-xs text-[var(--fg-muted)]">
                Going includes {view.counts.plusOnes}{' '}
                {view.counts.plusOnes === 1 ? 'plus-one' : 'plus-ones'}.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
