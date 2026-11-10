import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  buildPersonProfile,
  parsePersonEmail,
  personPagePath,
  type PersonProfile,
} from '@/lib/services/person-profile';
import { resolveTab } from '@/lib/util/page-tabs';
import { relativeTime } from '@/lib/util/time';
import { MeetingRow, ThreadRow } from '@/components/network/person-rows';
import { ContactStatusTag, formatContactDate } from '@/components/network/contact-status-tag';
import { StrengthBadge } from '@/components/network/strength-badge';
import { DataRow, PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, Notice } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'emails', label: 'Emails' },
  { key: 'meetings', label: 'Meetings' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
const TAB_KEYS: readonly TabKey[] = TABS.map((t) => t.key);

const BACK_HREF = '/network?tab=people&source=mail';

type Params = { params: Promise<{ email: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { email } = await params;
  return { title: parsePersonEmail(email) ?? 'Person' };
}

/**
 * One person from Network → People ("From mail and calendar"): who they are
 * and how warm, every email thread with them (each opening in Kraken or
 * Gmail), and every meeting with them and its notes, behind subtabs rather
 * than one long page. Built by services/person-profile.ts from synced mail,
 * calendar and meeting notes only.
 */
export default async function PersonPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ email: raw }, query] = await Promise.all([params, searchParams]);
  const email = parsePersonEmail(raw);
  if (!email) notFound();
  const tab = resolveTab(query.tab, TAB_KEYS, 'overview');
  const auth = await requireAuth();
  const timezone = auth.profile.timezone || 'UTC';
  const built = await buildPersonProfile(getStore(), auth, email);

  if (!built.ok) {
    if (built.error.code === 'not_found') notFound();
    return (
      <PageShell>
        <BackLink />
        <PageHeader title={email} />
        <ErrorState
          title="This person could not be loaded"
          message={built.error.message}
          stillUsable="The Network list, and everything else in Kraken."
        />
      </PageShell>
    );
  }
  const p = built.value;

  return (
    <PageShell>
      <BackLink />
      <PageHeader
        title={p.name ?? p.email}
        subtitle={p.name ? p.email : undefined}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <ContactStatusTag status={p.status} />
            <StrengthBadge label={p.strength.label} score={p.strength.score} summary={p.summary} />
            {p.domain ? <span className="text-sm">{p.domain}</span> : null}
          </span>
        }
      />
      <PageTabs
        label="Person sections"
        path={personPagePath(p.email)}
        tabs={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          count:
            t.key === 'emails'
              ? p.threads.length
              : t.key === 'meetings'
                ? p.meetings.length
                : undefined,
        }))}
        active={tab}
        defaultKey="overview"
      />
      {p.truncated ? (
        <Notice tone="info" className="mb-4">
          The newest threads and meetings are listed; older ones are counted in the strength.
        </Notice>
      ) : null}
      {tab === 'emails' ? (
        <EmailsTab profile={p} timezone={timezone} />
      ) : tab === 'meetings' ? (
        <MeetingsTab profile={p} timezone={timezone} />
      ) : (
        <OverviewTab profile={p} timezone={timezone} />
      )}
    </PageShell>
  );
}

function BackLink() {
  return (
    <Link
      href={BACK_HREF}
      className="text-mini mb-3 inline-flex items-center gap-1 text-[var(--fg-muted)] underline-offset-2 hover:underline"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      People from mail and calendar
    </Link>
  );
}

const linkClass = 'text-sm text-[var(--accent)] underline-offset-2 hover:underline';

function dateOrNot(at: string | null, timezone: string) {
  return at ? (
    <time dateTime={at}>
      {formatContactDate(at, timezone)} · {relativeTime(at)}
    </time>
  ) : (
    <span className="text-[var(--fg-subtle)] italic">Not yet</span>
  );
}

function OverviewTab({ profile: p, timezone }: { profile: PersonProfile; timezone: string }) {
  const e = p.evidence;
  const knownSince = [e.firstEmailAt, p.meetings.filter((m) => !m.upcoming).at(-1)?.at ?? null]
    .filter((x): x is string => !!x)
    .sort()[0];
  const recentThread = p.threads[0];
  const recentMeeting = p.meetings.find((m) => !m.upcoming);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0 space-y-8">
        <section aria-labelledby="person-relationship">
          <SectionHeading>
            <span id="person-relationship">Relationship</span>
          </SectionHeading>
          <Card>
            <CardContent className="pt-4">
              <dl className="divide-y divide-[var(--border)]">
                <DataRow label="Email">{p.email}</DataRow>
                <DataRow label="Company">{p.domain ?? 'Personal address'}</DataRow>
                <DataRow label="Strength">{p.summary}</DataRow>
                <DataRow label="Emails">
                  {e.emailsIn} from them · {e.emailsOut} from Nick · {e.threads}{' '}
                  {e.threads === 1 ? 'thread' : 'threads'}
                </DataRow>
                <DataRow label="Meetings">
                  {e.meetingsHeld} held
                  {e.nextMeetingAt ? ` · next ${formatContactDate(e.nextMeetingAt, timezone)}` : ''}
                </DataRow>
                <DataRow label="Known since">{dateOrNot(knownSince ?? null, timezone)}</DataRow>
                <DataRow label="Last contact">{dateOrNot(e.lastContactAt, timezone)}</DataRow>
              </dl>
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="person-latest">
          <SectionHeading>
            <span id="person-latest">Latest</span>
          </SectionHeading>
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4">
            {recentThread ? (
              <ThreadRow thread={recentThread} mailbox={p.mailbox} timezone={timezone} />
            ) : (
              <li className="py-3 text-sm text-[var(--fg-subtle)]">No email with them yet.</li>
            )}
            {recentMeeting ? (
              <MeetingRow meeting={recentMeeting} timezone={timezone} />
            ) : (
              <li className="py-3 text-sm text-[var(--fg-subtle)]">No meeting with them yet.</li>
            )}
          </ul>
        </section>
      </div>

      <aside className="min-w-0 space-y-8">
        <section aria-labelledby="person-tasks">
          <SectionHeading count={p.tasks.length}>
            <span id="person-tasks">Open tasks naming them</span>
          </SectionHeading>
          {p.tasks.length === 0 ? (
            <p className="text-sm text-[var(--fg-subtle)]">No open task mentions them.</p>
          ) : (
            <ul className="space-y-1.5">
              {p.tasks.map((t) => (
                <li key={t.id} className="text-sm">
                  <Link href="/tasks" className={linkClass}>
                    {t.title}
                  </Link>
                  {t.dueAt ? (
                    <span className="text-mini ml-2 text-[var(--fg-subtle)]">
                      due {formatContactDate(t.dueAt, timezone)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="person-elsewhere">
          <SectionHeading>
            <span id="person-elsewhere">Elsewhere in Kraken</span>
          </SectionHeading>
          <ul className="space-y-1.5">
            {p.records.map((r) => (
              <li key={r.id}>
                <Link href={`/lists/records/${r.id}`} className={linkClass}>
                  Profile on Lists: {r.name}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href={`/network/harmonic?q=${encodeURIComponent(p.name ?? p.email)}`}
                className={linkClass}
              >
                Search Harmonic
              </Link>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function EmailsTab({ profile: p, timezone }: { profile: PersonProfile; timezone: string }) {
  return (
    <section aria-labelledby="person-emails">
      <SectionHeading count={p.threads.length}>
        <span id="person-emails">Emails</span>
      </SectionHeading>
      {p.threads.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">No email with them in synced mail.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4">
          {p.threads.map((t) => (
            <ThreadRow key={t.key} thread={t} mailbox={p.mailbox} timezone={timezone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MeetingsTab({ profile: p, timezone }: { profile: PersonProfile; timezone: string }) {
  return (
    <section aria-labelledby="person-meetings">
      <SectionHeading count={p.meetings.length}>
        <span id="person-meetings">Meetings</span>
      </SectionHeading>
      {p.notesRead ? null : (
        <Notice tone="warn" className="mb-3">
          Meeting notes could not be read just now.
        </Notice>
      )}
      {p.meetings.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">
          No meetings with them in the calendar, Kraken Notes or Granola.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4">
          {p.meetings.map((m) => (
            <MeetingRow key={m.key} meeting={m} timezone={timezone} />
          ))}
        </ul>
      )}
    </section>
  );
}
