import Link from 'next/link';
import { CalendarDays, FileText, Mail } from 'lucide-react';
import { SectionHeading } from '@/components/shell/page-header';
import { Notice, PlainText } from '@/components/ui/feedback';
import { StrengthBadge } from '@/components/network/strength-badge';
import { SignalBars, formatContactDate } from '@/components/network/contact-status-tag';
import { ThreadLinksForHref } from '@/components/email/thread-links';
import type { ContactSummary, RecordRelationship } from '@/lib/services/relationships';
import { meetingPagePath } from '@/lib/notes/api';
import { ACTIVITY_WEEKS, weeklyCounts } from '@/lib/network/activity';
import type { CrmRecord, MeetingNote } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';
import type { Result } from '@/lib/util/result';

/**
 * The Connections and Activity subtabs of a person's or company's profile.
 * Each takes its data as promises the page started once, so the tab bar and
 * header paint first and these stream in.
 */

type ContactLine = Promise<{ ok: true; value: ContactSummary | null } | { ok: false }>;

/**
 * Who on the team knows them (strongest first, with signal bars from how
 * often and how recently), the last contact and by whom, and — for a
 * company — the people there the fund knows; for a person, their colleagues.
 */
export async function RecordConnections({
  contact,
  relationship,
  kind,
  timezone,
}: {
  contact: ContactLine;
  relationship: Promise<Result<RecordRelationship>>;
  kind: CrmRecord['kind'];
  timezone: string;
}) {
  const [line, rel] = await Promise.all([contact, relationship]);
  const summary = line.ok ? line.value : null;
  const now = new Date();
  return (
    <div className="space-y-8">
      <section aria-labelledby="profile-team">
        <SectionHeading count={summary?.connections.length}>
          <span id="profile-team">Who on the team knows them</span>
        </SectionHeading>
        {!line.ok ? (
          <Notice tone="warn">Mail and calendar couldn&rsquo;t be read just now.</Notice>
        ) : !summary || summary.connections.length === 0 ? (
          <p className="text-sm text-[var(--fg-subtle)]">
            {summary?.lastContactAt
              ? 'Met in meetings only, with no email on record that shows who on the team was in touch.'
              : 'Nobody on the team has emailed with them in synced mail.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {summary.connections.map((c, i) => (
              <li key={c.name} className="flex items-center gap-3 px-4 py-3">
                <SignalBars bars={c.bars} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {c.name}
                    {i === 0 && summary.connections.length > 1 ? (
                      <span className="text-mini ml-2 font-normal text-[var(--label-gold)]">
                        strongest
                      </span>
                    ) : null}
                  </p>
                  <p className="text-mini text-[var(--fg-muted)]">
                    {c.threads} {c.threads === 1 ? 'thread' : 'threads'}
                    {c.lastAt ? ` · last ${formatContactDate(c.lastAt, timezone)}` : ''}
                  </p>
                </div>
                {c.lastAt ? (
                  <time
                    dateTime={c.lastAt}
                    className="text-mini tabular shrink-0 text-[var(--fg-subtle)]"
                  >
                    {relativeTime(c.lastAt, now)}
                  </time>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {summary?.lastContactAt ? (
          <p className="text-mini mt-2 text-[var(--fg-muted)]">
            Last contact {formatContactDate(summary.lastContactAt, timezone, true)}
            {summary.lastTouchText ? `: ${summary.lastTouchText}` : ''}.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="profile-known-people">
        <SectionHeading count={rel.ok ? rel.value.people.length : undefined}>
          <span id="profile-known-people">
            {kind === 'company' ? 'People there we know' : 'Colleagues we know'}
          </span>
        </SectionHeading>
        {!rel.ok ? (
          <Notice tone="warn">{rel.error.message}</Notice>
        ) : rel.value.people.length === 0 ? (
          <p className="text-sm text-[var(--fg-subtle)]">
            {kind === 'company'
              ? 'Nobody at this company in synced mail or the calendar yet.'
              : 'No colleagues of theirs in synced mail or the calendar yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {rel.value.people.map((p) => (
              <li key={p.email} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {p.recordId ? (
                    <Link
                      href={`/lists/records/${p.recordId}`}
                      className="text-sm font-medium underline-offset-2 hover:underline"
                    >
                      {p.name ?? p.email}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{p.name ?? p.email}</span>
                  )}
                  <p className="text-mini truncate text-[var(--fg-muted)]">
                    {p.name ? `${p.email} · ` : ''}
                    {p.summary}
                  </p>
                </div>
                <StrengthBadge
                  label={p.strength.label}
                  score={p.strength.score}
                  summary={p.summary}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface ActivityItem {
  key: string;
  kind: 'email' | 'meeting' | 'note';
  at: string;
  title: string;
  detail: string;
  href: string | null;
  internal: boolean;
  upcoming: boolean;
  /** A meeting note's text, read in place. Untrusted: rendered as text only. */
  content?: string;
  flagged?: boolean;
}

const WEEKS = ACTIVITY_WEEKS;

/**
 * Every email thread, meeting and meeting note with them, newest first (a
 * booked meeting still ahead on top), with a small chart of how many a week
 * over the last twelve weeks.
 */
export async function RecordActivity({
  relationship,
  notes,
  timezone,
}: {
  relationship: Promise<Result<RecordRelationship>>;
  notes: Promise<MeetingNote[] | null>;
  timezone: string;
}) {
  const [rel, meetingNotes] = await Promise.all([relationship, notes]);
  const now = new Date();
  const items: ActivityItem[] = [];
  if (rel.ok) {
    for (const t of rel.value.activity) {
      items.push({
        key: `${t.kind}-${t.key}`,
        kind: t.kind === 'meeting' ? 'meeting' : 'email',
        at: t.at,
        title: t.title,
        detail: t.detail,
        href: t.href,
        internal: false,
        upcoming: t.upcoming,
      });
    }
  }
  for (const n of meetingNotes ?? []) {
    const kraken = n.provider === 'copilot';
    const who = n.attendees.map((a) => a.name ?? a.email).join(', ');
    items.push({
      key: `note-${n.id}`,
      kind: 'note',
      at: n.occurred_at,
      title: n.title,
      detail: `${who ? `${who} · ` : ''}meeting notes from ${kraken ? 'Kraken' : 'Granola'}`,
      href: kraken ? meetingPagePath(n.meeting_id ?? n.external_id) : (n.source_url ?? null),
      internal: kraken,
      upcoming: false,
      content: n.content,
      flagged: n.injection_flagged,
    });
  }
  const upcoming = items.filter((i) => i.upcoming).sort((a, b) => a.at.localeCompare(b.at));
  const past = items
    .filter((i) => !i.upcoming)
    .sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  const ordered = [...upcoming, ...past];
  const weekly = weeklyCounts(past, now);
  const peak = Math.max(1, ...weekly);
  const total = weekly.reduce((a, b) => a + b, 0);

  return (
    <section aria-labelledby="profile-activity" data-profile-activity="">
      <SectionHeading count={ordered.length}>
        <span id="profile-activity">Activity</span>
      </SectionHeading>
      {!rel.ok ? <Notice tone="warn">{rel.error.message}</Notice> : null}
      {meetingNotes === null ? (
        <Notice tone="warn">Meeting notes could not be read just now.</Notice>
      ) : null}
      <figure className="mb-4">
        <div
          className="flex h-12 items-end gap-1"
          role="img"
          aria-label={`${total} emails, meetings and notes in the last ${WEEKS} weeks, by week`}
        >
          {weekly.map((n, i) => (
            <span
              key={i}
              title={`${n} in the week ${WEEKS - 1 - i === 0 ? 'to today' : `${WEEKS - 1 - i} weeks back`}`}
              className={
                n
                  ? 'flex-1 rounded-t-sm bg-[var(--accent)]'
                  : 'flex-1 rounded-t-sm bg-[var(--chart-track)]'
              }
              style={{ height: `${n ? Math.max(12, (n / peak) * 100) : 6}%` }}
            />
          ))}
        </div>
        <figcaption className="text-mini mt-1 flex justify-between text-[var(--fg-subtle)]">
          <span>{WEEKS} weeks ago</span>
          <span>
            {total} in {WEEKS} weeks
          </span>
          <span>this week</span>
        </figcaption>
      </figure>
      {ordered.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">
          No emails, meetings or meeting notes with them in synced mail, the calendar or Granola.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4">
          {ordered.map((item) => (
            <ActivityRow key={item.key} item={item} now={now} timezone={timezone} />
          ))}
        </ul>
      )}
    </section>
  );
}

const ICON = { email: Mail, meeting: CalendarDays, note: FileText } as const;

function ActivityRow({ item, now, timezone }: { item: ActivityItem; now: Date; timezone: string }) {
  const Icon = ICON[item.kind];
  return (
    <li className="flex items-start gap-2.5 py-2.5" data-activity-kind={item.kind}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <p className="text-mini text-[var(--fg-muted)]">
          {item.upcoming ? <span className="text-[var(--accent)]">Upcoming · </span> : null}
          {item.detail}
        </p>
        {item.content ? (
          <details className="mt-1">
            <summary className="text-mini cursor-pointer text-[var(--fg-muted)]">
              Read the note
            </summary>
            {item.flagged ? (
              <Notice tone="warn" className="mt-2">
                This note contains text aimed at an AI assistant. It was treated as data, not
                instructions.
              </Notice>
            ) : null}
            <PlainText text={item.content} className="mt-2 text-[var(--fg-muted)]" />
          </details>
        ) : null}
        {item.kind === 'email' ? (
          <ThreadLinksForHref href={item.href} label={item.title} variant="text" fallback={null} />
        ) : item.href ? (
          item.internal ? (
            <Link
              href={item.href}
              className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
            >
              Open the meeting: notes, transcript and chat
            </Link>
          ) : (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
            >
              Open in Granola
            </a>
          )
        ) : null}
      </div>
      <time
        dateTime={item.at}
        title={formatContactDate(item.at, timezone, true)}
        className="text-mini tabular shrink-0 whitespace-nowrap text-[var(--fg-subtle)]"
      >
        {relativeTime(item.at, now)}
      </time>
    </li>
  );
}
