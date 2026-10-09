import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CalendarClock, ExternalLink, HeartHandshake, Hourglass, NotebookPen } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { gmailThreadUrl } from '@/lib/deals/links';
import { getStore } from '@/lib/runtime';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import {
  readFollowUps,
  type FollowUpItem,
  type FollowUpsState,
  type MeetingFollowUp,
  type RelationshipItem,
  type SchedulingItem,
} from '@/lib/services/follow-ups';
import { readEmailSession } from '@/lib/services/email-session';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { mailboxOwnerPresence, type MailboxOwnerPresence } from '@/lib/services/presence';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { EmailSessionCard } from '@/components/followups/email-session-card';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Notice, SkeletonText } from '@/components/ui/feedback';
import { formatDate, formatDateTime, relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Follow-ups' };
export const dynamic = 'force-dynamic';

export default function FollowUpsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Follow-ups"
        subtitle="Who is waiting on you, who you are waiting on, recaps drafted after your meetings, and meeting times drafted into replies. Every draft sits in Gmail for review; nothing is sent unless you tap Send in an email session."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <FollowUpsContent />
      </Suspense>
    </PageShell>
  );
}

const STATE_MESSAGE: Partial<Record<FollowUpsState, string>> = {
  not_configured: 'The Slack read token is not set, so the follow-up routines cannot be read.',
  restricted:
    'This page stays closed until sign-in is limited to TipTop accounts (AUTH_ALLOWED_EMAIL_DOMAINS), because it names the people and threads you are waiting on.',
  other_workspace: 'Follow-ups are only read for the TipTop workspace.',
  bot_not_in_channel: 'The Copilot Slack app is not a member of #deal-relay.',
  missing_scope: 'The Copilot Slack app is missing the groups:history scope.',
  bad_token: 'The Slack token was refused.',
  rate_limited: 'Slack is rate-limiting reads. Try again in a minute.',
  error: 'Reading #deal-relay failed. Try again in a minute.',
};

async function FollowUpsContent() {
  const auth = await requireAuth();
  const now = new Date();
  const { state, snapshot } = await readFollowUps(getStore(), auth.organizationId, { now });
  const tz = auth.profile.timezone;

  if (state !== 'ok') {
    return (
      <Notice tone="warn">
        <p>{STATE_MESSAGE[state] ?? 'Follow-ups could not be loaded.'}</p>
      </Notice>
    );
  }

  const waiting = snapshot.waiting?.items ?? [];
  const onYou = snapshot.relationships?.waiting ?? [];
  const session = await readEmailSession(getStore(), auth.organizationId, { now });
  const integration = await getPrimaryIntegration(getStore(), auth.organizationId).catch(
    () => null,
  );
  const presence = auth.isDemo
    ? null
    : await mailboxOwnerPresence(
        getStore(),
        auth.organizationId,
        auth.userId,
        integration?.account_email,
      ).catch(() => null);
  return (
    <div className="space-y-8">
      <AutoRefresh minutes={10} />
      <div className="space-y-2">
        <EmailSessionCard session={session} />
        {presence ? <PresenceLine presence={presence} now={now} /> : null}
      </div>
      <section aria-labelledby="on-you-heading">
        <SectionHeading count={onYou.length}>
          <span id="on-you-heading">Waiting on you</span>
        </SectionHeading>
        <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
          LPs, portfolio founders, co-investors and founders in a live process who asked you for
          something and have not heard back.{' '}
          {snapshot.relationships
            ? `Checked ${relativeTime(snapshot.relationships.run_at, now)}.`
            : 'The relationship radar has not posted yet.'}
        </p>
        {onYou.length === 0 ? (
          <EmptyLine>
            {snapshot.relationships ? 'Nobody important is waiting on you.' : 'Nothing yet.'}
          </EmptyLine>
        ) : (
          <ul className="space-y-2">
            {onYou.map((item) => (
              <OnYouRow key={`${item.who}-${item.since}`} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="waiting-heading">
        <SectionHeading count={waiting.length}>
          <span id="waiting-heading">You&apos;re waiting on</span>
        </SectionHeading>
        <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
          You wrote last and haven&apos;t heard back.{' '}
          {snapshot.waiting
            ? `Checked ${relativeTime(snapshot.waiting.runAt, now)}.`
            : 'The tracker has not posted yet.'}
        </p>
        {waiting.length === 0 ? (
          <EmptyLine>{snapshot.waiting ? 'Nobody is overdue a reply.' : 'Nothing yet.'}</EmptyLine>
        ) : (
          <ul className="space-y-2">
            {waiting.map((item) => (
              <WaitingRow key={item.thread_id} item={item} tz={tz} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="meetings-heading">
        <SectionHeading count={snapshot.meetings.length}>
          <span id="meetings-heading">Meeting recaps</span>
        </SectionHeading>
        <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
          After each external meeting in Granola, a thank-you and recap is drafted to the attendees.
          Anything you promised also lands on Tasks.
        </p>
        {snapshot.meetings.length === 0 ? (
          <EmptyLine>No recaps drafted in the last two weeks.</EmptyLine>
        ) : (
          <ul className="space-y-2">
            {snapshot.meetings.map((m) => (
              <MeetingRow key={m.meeting_id} meeting={m} tz={tz} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="scheduling-heading">
        <SectionHeading count={snapshot.scheduling.length}>
          <span id="scheduling-heading">Scheduling drafts</span>
        </SectionHeading>
        <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
          Emails asking to find a time get a reply drafted with real open slots from your calendar,
          Tuesday to Thursday.
        </p>
        {snapshot.scheduling.length === 0 ? (
          <EmptyLine>No scheduling replies drafted in the last two weeks.</EmptyLine>
        ) : (
          <ul className="space-y-2">
            {snapshot.scheduling.map((s) => (
              <SchedulingRow key={s.thread_id} item={s} tz={tz} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** For Arwin: whether Nick has been in, so nobody has to ask him. */
function PresenceLine({ presence, now }: { presence: MailboxOwnerPresence; now: Date }) {
  const { name, signedIn, lastSeenAt, alertDevices } = presence;
  const seen = !signedIn
    ? `${name} hasn't signed in to the app yet`
    : lastSeenAt
      ? `${name} last opened the app ${relativeTime(lastSeenAt, now)}`
      : `${name} hasn't opened the app since visits started being tracked (Oct 9)`;
  const alerts = signedIn
    ? alertDevices > 0
      ? `phone alerts on (${alertDevices} ${alertDevices === 1 ? 'device' : 'devices'})`
      : 'phone alerts not set up'
    : null;
  return (
    <p className="px-1 text-xs text-[var(--fg-subtle)]">
      {seen}
      {alerts ? ` · ${alerts}` : ''}
    </p>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--fg-subtle)]">{children}</p>;
}

function ThreadLink({ threadId }: { threadId: string | null | undefined }) {
  const href = threadId ? gmailThreadUrl(threadId, DEFAULT_MAILBOX) : null;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
    >
      Open in Gmail <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

const KIND_LABEL: Record<RelationshipItem['kind'], string> = {
  lp: 'LP',
  prospective_lp: 'Prospective LP',
  portfolio: 'Portfolio',
  founder: 'Founder',
  coinvestor: 'Co-investor',
  other: 'Contact',
};

function OnYouRow({ item }: { item: RelationshipItem }) {
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-4">
          <HeartHandshake className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {item.who}
                {item.company ? (
                  <span className="text-[var(--fg-muted)]"> · {item.company}</span>
                ) : null}
              </span>
              <Badge tone="neutral">{KIND_LABEL[item.kind]}</Badge>
              <Badge tone={waitTone(item.days)}>
                {item.days} {item.days === 1 ? 'day' : 'days'}
              </Badge>
            </div>
            {item.note ? <p className="mt-0.5 text-sm">{item.note}</p> : null}
          </div>
          <ThreadLink threadId={item.thread_id} />
        </CardContent>
      </Card>
    </li>
  );
}

function waitTone(days: number): 'danger' | 'warn' | 'neutral' {
  if (days >= 14) return 'danger';
  if (days >= 7) return 'warn';
  return 'neutral';
}

function WaitingRow({ item, tz }: { item: FollowUpItem; tz: string }) {
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-4">
          <Hourglass className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {item.who}
                {item.company ? (
                  <span className="text-[var(--fg-muted)]"> · {item.company}</span>
                ) : null}
              </span>
              <Badge tone={waitTone(item.days_waiting)}>
                {item.days_waiting} {item.days_waiting === 1 ? 'day' : 'days'}
              </Badge>
              {item.draft ? <Badge tone="ok">Nudge drafted</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-sm">{item.subject}</p>
            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
              You wrote {formatDate(item.last_sent_at, tz)}
              {item.note ? ` · ${item.note}` : ''}
            </p>
          </div>
          <ThreadLink threadId={item.thread_id} />
        </CardContent>
      </Card>
    </li>
  );
}

function MeetingRow({ meeting, tz }: { meeting: MeetingFollowUp; tz: string }) {
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-4">
          <NotebookPen className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{meeting.title}</span>
              {meeting.draft ? (
                <Badge tone="ok">Recap drafted</Badge>
              ) : (
                <Badge tone="neutral">No draft</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
              {formatDateTime(meeting.met_at, tz)}
              {meeting.attendees.length > 0 ? ` · ${meeting.attendees.join(', ')}` : ''}
            </p>
            {meeting.promises.length > 0 ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-[var(--fg-muted)]">
                {meeting.promises.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {meeting.note ? (
              <p className="mt-1 text-xs text-[var(--fg-subtle)]">{meeting.note}</p>
            ) : null}
          </div>
          <ThreadLink threadId={meeting.thread_id} />
        </CardContent>
      </Card>
    </li>
  );
}

function SchedulingRow({ item, tz }: { item: SchedulingItem; tz: string }) {
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-4">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.who}</span>
              {item.draft ? <Badge tone="ok">Times drafted</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-sm">{item.subject}</p>
            {item.slots.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.slots.map((slot) => (
                  <Badge key={slot} tone="info">
                    {formatDateTime(slot, tz)}
                  </Badge>
                ))}
              </div>
            ) : null}
            {item.note ? <p className="mt-1 text-xs text-[var(--fg-subtle)]">{item.note}</p> : null}
          </div>
          <ThreadLink threadId={item.thread_id} />
        </CardContent>
      </Card>
    </li>
  );
}
