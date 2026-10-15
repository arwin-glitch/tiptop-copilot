import { CalendarClock } from 'lucide-react';
import { dueLabel, type CadenceStatus } from '@/lib/crm/cadence';
import type { ContactEvidence } from '@/lib/crm/contact-evidence';
import { getStore } from '@/lib/runtime';
import { keepInTouchFor, type CadenceRecord } from '@/lib/services/keep-in-touch';
import { formatDate } from '@/lib/util/time';
import { KeepInTouchControl } from '@/components/network/keep-in-touch-control';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

const KIND_LABEL: Record<NonNullable<ContactEvidence['lastContactKind']>, string> = {
  inbound: 'Email from them',
  outbound: 'Email to them',
  meeting: 'Meeting',
};

export const STATE_TONE: Record<CadenceStatus['state'], NonNullable<BadgeProps['tone']>> = {
  overdue: 'danger',
  due_soon: 'warn',
  on_track: 'ok',
};

/**
 * Keep in touch, on a profile: the cadence picker, the last contact it is
 * counted from, and when the next check-in is due — every date one the
 * person can check against their own mail and calendar. The last contact is
 * read from the same relationship index as the Relationship panel beside it,
 * so the two always show the same date; the next meeting is left to that
 * panel rather than shown twice.
 */
export async function KeepInTouchCard({
  record,
  organizationId,
  timezone,
  canEdit,
}: {
  record: CadenceRecord;
  organizationId: string;
  timezone: string;
  canEdit: boolean;
}) {
  const found = await keepInTouchFor(getStore(), organizationId, record);
  const days = found.ok ? (found.value.cadence?.days ?? null) : null;
  return (
    <section aria-labelledby="profile-keep-in-touch">
      <SectionHeading>
        <span id="profile-keep-in-touch">Keep in touch</span>
      </SectionHeading>
      <Card>
        <CardContent className="space-y-4 pt-4">
          {found.ok ? (
            <>
              <KeepInTouchControl
                key={days ?? 'off'}
                recordId={record.id}
                name={record.name}
                days={days}
                canEdit={canEdit}
              />
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-mini text-[var(--fg-subtle)]">Last contact</dt>
                  <dd>
                    {found.value.evidence.lastContactAt && found.value.evidence.lastContactKind ? (
                      <>
                        {KIND_LABEL[found.value.evidence.lastContactKind]} ·{' '}
                        {formatDate(found.value.evidence.lastContactAt, timezone)}
                      </>
                    ) : (
                      <span className="text-[var(--fg-muted)]">
                        None in synced mail or calendar
                        {record.kind === 'company' && !record.domain ? ' (no domain to match)' : ''}
                      </span>
                    )}
                  </dd>
                </div>
                {found.value.status ? (
                  <div>
                    <dt className="text-mini text-[var(--fg-subtle)]">Next check-in</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <CalendarClock
                        className="size-3.5 text-[var(--fg-subtle)]"
                        aria-hidden="true"
                      />
                      {formatDate(found.value.status.dueAt, timezone)}
                      <Badge tone={STATE_TONE[found.value.status.state]}>
                        {dueLabel(found.value.status)}
                      </Badge>
                    </dd>
                    <dd className="text-mini mt-1 text-[var(--fg-muted)]">
                      {basisLine(found.value.status, found.value.lastCheckInAt, timezone)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </>
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">{found.error.message}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Where the due date comes from, in words. */
export function basisLine(
  status: CadenceStatus,
  checkInAt: string | null,
  timezone: string,
): string {
  if (status.basis === 'contact') return 'Counted from the last contact.';
  if (status.basis === 'check_in' && checkInAt) {
    return `Counted from the check-in task closed on ${formatDate(checkInAt, timezone)}.`;
  }
  return `No contact on record, so counted from when the cadence was set (${formatDate(status.anchorAt, timezone)}).`;
}
