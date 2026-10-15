import Link from 'next/link';
import { ArrowUpRight, CalendarDays, Mail, Snowflake } from 'lucide-react';
import { WarmPaths } from '@/components/fund-ii/warm-paths';
import { StrengthBadge } from '@/components/network/strength-badge';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import {
  DEFAULT_GOING_COLD_DAYS,
  formatSmartValue,
  recencyText,
  SMART_FIELD_KEYS,
  SMART_FIELD_LABELS,
} from '@/lib/network/strength';
import type { RecordRelationship, TimelineItem } from '@/lib/services/relationships';
import type { CrmRecord } from '@/lib/types/domain';
import { formatDate, relativeTime } from '@/lib/util/time';
import type { Result } from '@/lib/util/result';

type Loaded = Promise<Result<RecordRelationship>>;

/**
 * A record profile's Relationship panel: how strong the relationship is, the
 * arithmetic behind the number, the smart fields, and the recent threads and
 * meetings it was counted from. Takes the computation as a promise so the
 * page starts it once and this panel and "Who can intro" both stream in when
 * it lands.
 */
export async function RelationshipPanel({
  relationship,
  kind,
  timezone,
}: {
  relationship: Loaded;
  kind: CrmRecord['kind'];
  timezone: string;
}) {
  const result = await relationship;
  const heading = (
    <SectionHeading>
      <span id="profile-relationship">Relationship</span>
    </SectionHeading>
  );
  if (!result.ok) {
    return (
      <section aria-labelledby="profile-relationship">
        {heading}
        <Notice tone="warn">{result.error.message}</Notice>
      </section>
    );
  }
  const r = result.value;
  const now = new Date();
  const { strength } = r;
  // A score is only shown when there is evidence to score. With none, a "0"
  // would claim "no relationship" where Copilot simply has nothing on record,
  // or nothing to match on at all.
  const scored = strength.label !== 'none';
  const unscoredReason = !r.matched.matchable
    ? kind === 'company'
      ? 'No domain or people to match against mail and calendar, so there is nothing to score.'
      : 'No email address to match against mail and calendar, so there is nothing to score.'
    : 'No mail or meetings with them in synced mail or the calendar.';
  const affinityContact =
    r.smart.last_contact.source === 'affinity' && r.smart.last_contact.at
      ? formatSmartValue(r.smart.last_contact, timezone)
      : null;

  return (
    <section aria-labelledby="profile-relationship" data-testid="relationship-panel">
      {heading}
      <Card>
        <CardContent className="space-y-5 pt-4 pb-4">
          {scored ? (
            <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
              <div className="flex items-baseline gap-2">
                <span className="tabular font-serif text-4xl leading-none font-semibold">
                  {strength.score}
                </span>
                <span className="text-mini text-[var(--fg-subtle)]">/ 100</span>
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StrengthBadge label={strength.label} score={strength.score} showScore={false} />
                  {r.goingCold ? (
                    <Badge tone="info" title={`No contact for ${DEFAULT_GOING_COLD_DAYS}+ days`}>
                      <Snowflake className="size-3" aria-hidden="true" />
                      Going cold
                    </Badge>
                  ) : null}
                </div>
                <p className="text-sm text-[var(--fg-muted)]" data-testid="relationship-evidence">
                  {r.summary}
                </p>
                <Meter score={strength.score} />
              </div>
            </div>
          ) : (
            <div className="space-y-1" data-testid="relationship-unscored">
              <p className="font-serif text-xl leading-tight font-semibold">
                {r.matched.matchable ? 'No score yet' : 'Not scored'}
              </p>
              <p className="text-sm text-[var(--fg-muted)]" data-testid="relationship-evidence">
                {unscoredReason}
                {affinityContact
                  ? ` Affinity last recorded contact on ${affinityContact}; that is shown below, marked, but not scored.`
                  : ''}
              </p>
            </div>
          )}

          {scored ? (
            <details className="group rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium select-none">
                Why {strength.score}?
              </summary>
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">How the relationship score was counted</caption>
                <tbody className="divide-y divide-[var(--border)]">
                  {strength.parts.map((part) => (
                    <tr key={part.key}>
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {part.label}
                      </th>
                      <td className="tabular py-1.5 text-right whitespace-nowrap text-[var(--fg-muted)]">
                        +{part.points}
                        <span className="text-[var(--fg-subtle)]"> / {part.max}</span>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                      Recency: {recencyText(strength)}
                    </th>
                    <td className="tabular py-1.5 text-right whitespace-nowrap text-[var(--fg-muted)]">
                      {strength.base} × {strength.recency.toFixed(2)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-1.5 pr-3 text-left font-semibold">
                      Score
                    </th>
                    <td className="tabular py-1.5 text-right font-semibold">{strength.score}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-mini mt-2 text-[var(--fg-subtle)]">
                Counts from synced mail and calendar, no model. Strong is 60 and up, Warm 30 and up.
                Half the strength fades every 120 days without contact.
              </p>
            </details>
          ) : null}

          <dl className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-x-4 gap-y-3">
            {SMART_FIELD_KEYS.map((key) => {
              const value = r.smart[key];
              return (
                <div key={key} className="min-w-0" data-smart-field={key}>
                  <dt className="text-micro tracking-wide text-[var(--fg-subtle)] uppercase">
                    {SMART_FIELD_LABELS[key]}
                  </dt>
                  <dd className="tabular mt-0.5 text-sm">
                    {value.at ? formatSmartValue(value, timezone) : '—'}
                    {value.source === 'affinity' ? (
                      <span className="text-mini block text-[var(--label-gold)]">
                        from Affinity
                      </span>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>

          {r.timeline.length > 0 ? (
            <div>
              <h3 className="text-micro mb-1.5 tracking-wide text-[var(--fg-subtle)] uppercase">
                Recent threads and meetings
              </h3>
              <ul className="divide-y divide-[var(--border)]">
                {r.timeline.map((item) => (
                  <TimelineRow
                    key={`${item.kind}-${item.key}`}
                    item={item}
                    now={now}
                    tz={timezone}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {r.scanned.oldestMessageAt ? (
            <p className="text-mini text-[var(--fg-subtle)]">
              From the newest {r.scanned.messages.toLocaleString('en-US')} synced messages (back to{' '}
              {formatDate(r.scanned.oldestMessageAt, timezone)}) and the calendar.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function Meter({ score }: { score: number }) {
  return (
    <div
      className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--chart-track)]"
      aria-hidden="true"
    >
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${score}%` }} />
    </div>
  );
}

function TimelineRow({ item, now, tz }: { item: TimelineItem; now: Date; tz: string }) {
  const Icon = item.kind === 'meeting' ? CalendarDays : Mail;
  return (
    <li className="flex items-start gap-2.5 py-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {item.href ? (
          <a
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
          >
            <span className="truncate">{item.title}</span>
            <ArrowUpRight className="size-3 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <span className="sr-only"> (opens Gmail)</span>
          </a>
        ) : (
          <span className="block truncate text-sm font-medium">{item.title}</span>
        )}
        <p className="text-mini text-[var(--fg-muted)]">
          {item.upcoming ? <span className="text-[var(--accent)]">Upcoming · </span> : null}
          {item.detail}
        </p>
      </div>
      <time
        dateTime={item.at}
        title={formatDate(item.at, tz)}
        className="text-mini tabular shrink-0 whitespace-nowrap text-[var(--fg-subtle)]"
      >
        {relativeTime(item.at, now)}
      </time>
    </li>
  );
}

/**
 * "Who can intro": the people Nick already knows at the company (or a
 * person's colleagues), strongest first, and who else shares small threads
 * with them — warm-paths' rules run over synced mail. The 3-year Gmail
 * lookup Fund II uses is one click further.
 */
export async function WhoCanIntro({
  relationship,
  record,
}: {
  relationship: Loaded;
  record: Pick<CrmRecord, 'kind' | 'name' | 'domain' | 'primary_email'>;
}) {
  const result = await relationship;
  const isCompany = record.kind === 'company';
  const heading = (
    <SectionHeading>
      <span id="profile-intros">Who can intro</span>
    </SectionHeading>
  );
  if (!result.ok) {
    return (
      <section aria-labelledby="profile-intros">
        {heading}
        <p className="text-sm text-[var(--fg-subtle)]">{result.error.message}</p>
      </section>
    );
  }
  const { people, introducers } = result.value;
  // The live lookup works from an address: a person's own, or for a company
  // the best-known person there (its domain is then the target), else by name.
  const lookupEmail = isCompany ? (people[0]?.email ?? null) : record.primary_email;
  const lookupFirm = isCompany && !lookupEmail ? record.name : null;

  return (
    <section aria-labelledby="profile-intros" data-testid="who-can-intro">
      {heading}
      <div className="space-y-4">
        <div>
          <h3 className="text-micro mb-1.5 tracking-wide text-[var(--fg-subtle)] uppercase">
            {isCompany ? 'Nick knows there' : 'Colleagues Nick knows'}
          </h3>
          {people.length === 0 ? (
            <p className="text-sm text-[var(--fg-subtle)]">
              {isCompany
                ? 'Nobody at this company in synced mail or the calendar.'
                : 'Nobody else at their company in synced mail or the calendar.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.email} className="rounded-md px-2 py-1.5 hover:bg-[var(--bg-hover)]">
                  <div className="flex items-center justify-between gap-2">
                    {p.recordId ? (
                      <Link
                        href={`/lists/records/${p.recordId}`}
                        className="truncate text-sm font-medium underline-offset-2 hover:underline"
                      >
                        {p.name ?? p.email}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-medium">{p.name ?? p.email}</span>
                    )}
                    <StrengthBadge
                      label={p.strength.label}
                      score={p.strength.score}
                      summary={p.summary}
                    />
                  </div>
                  <p className="text-mini truncate text-[var(--fg-muted)]">{p.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-micro mb-1.5 tracking-wide text-[var(--fg-subtle)] uppercase">
            Could introduce Nick
          </h3>
          {introducers.length === 0 ? (
            <p className="text-sm text-[var(--fg-subtle)]">
              Nobody outside TipTop shares a small thread with {isCompany ? 'anyone there' : 'them'}{' '}
              in synced mail.
            </p>
          ) : (
            <ul className="space-y-1">
              {introducers.map((p) => (
                <li key={p.email} className="px-2 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={p.email}>
                      {p.name ?? p.email}
                    </span>
                    <span className="text-mini tabular shrink-0 text-[var(--fg-subtle)]">
                      {p.threads} shared {p.threads === 1 ? 'thread' : 'threads'}
                    </span>
                  </div>
                  {p.href ? (
                    <a
                      href={p.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-mini inline-flex max-w-full items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      <span className="truncate">{p.subject || '(no subject)'}</span>
                      <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  ) : (
                    <p className="text-mini truncate text-[var(--fg-muted)]">{p.subject}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {lookupEmail || lookupFirm ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
            <span className="text-mini text-[var(--fg-subtle)]">Three years of Gmail:</span>
            <WarmPaths email={lookupEmail} firm={lookupFirm} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
