import type { ReactNode } from 'react';
import { CalendarDays, FileText } from 'lucide-react';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type {
  FollowUpsState,
  IntroItem,
  Intros,
  LpUpdateDraft,
  PortfolioHealth,
  PortfolioHealthItem,
  WeekAhead,
  WeekEvent,
} from '@/lib/services/follow-ups';
import { introKey, type IntroDraft } from '@/lib/intros/intro-draft';
import type { StaticFeedId } from '@/lib/feeds/registry';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { WriteIntroButton } from '@/components/followups/write-intro-button';
import { StaleHint } from '@/components/feeds/stale-hint';
import { ThreadLinks } from '@/components/email/thread-links';
import { formatDate, formatTime, formatWeekdayLong, relativeTime } from '@/lib/util/time';

/**
 * Cards for the routines' snapshots in #deal-relay. Plain text only; every
 * link is rebuilt from a validated Gmail thread id, never taken from a post.
 */

/** A row's thread as two icons, Kraken's Inbox and Gmail; `label` says what the thread is. */
function GmailLink({ threadId, label }: { threadId: string | null | undefined; label: string }) {
  return (
    <ThreadLinks
      id={threadId}
      mailbox={DEFAULT_MAILBOX}
      label={label}
      variant="icons"
      className="-mt-1 -mr-1 flex-nowrap"
    />
  );
}

/**
 * Why a routine's snapshot is not shown, in one plain sentence, for a page
 * whose whole tab is that snapshot. `null` is a read that threw.
 */
export function snapshotUnavailable(state: FollowUpsState | null | undefined): string {
  switch (state) {
    case 'restricted':
      return 'This stays hidden until sign-in is limited to TipTop accounts (AUTH_ALLOWED_EMAIL_DOMAINS).';
    case 'not_configured':
      return 'The Slack read token is not set, so the routine cannot be read.';
    default:
      return "The routine's post couldn't be read from Slack right now. Try again in a minute.";
  }
}

/** "Checked 2h ago", and that it may be out of date once its feed looks stopped. */
function Checked({ at, now, feed }: { at: string; now: Date; feed: StaticFeedId }) {
  return (
    <p className="text-xs text-[var(--fg-subtle)]">
      Checked {relativeTime(at, now)}
      <StaleHint feed={feed} checkedAt={at} now={now} />
    </p>
  );
}

/* ------------------------------ portfolio ------------------------------ */

const FLAG: Record<PortfolioHealthItem['flag'], { label: string; tone: BadgeProps['tone'] }> = {
  risk: { label: 'At risk', tone: 'danger' },
  watch: { label: 'Watch', tone: 'warn' },
  ok: { label: 'Healthy', tone: 'ok' },
  unknown: { label: 'No signal', tone: 'neutral' },
};
const FLAG_ORDER: PortfolioHealthItem['flag'][] = ['risk', 'watch', 'unknown', 'ok'];

export function PortfolioHealthCard({
  health,
  now,
  tz,
  empty = null,
}: {
  health: PortfolioHealth;
  now: Date;
  tz: string;
  /** What to show when the check lists no company. Nothing, by default. */
  empty?: ReactNode;
}) {
  if (health.companies.length === 0) return empty;
  const sorted = [...health.companies].sort(
    (a, b) => FLAG_ORDER.indexOf(a.flag) - FLAG_ORDER.indexOf(b.flag),
  );
  return (
    <Card className="mb-8" data-tour="portfolio-health">
      <CardHeader>
        <div>
          <CardTitle>Portfolio health</CardTitle>
          <Checked at={health.run_at} now={now} feed="portfolio-health" />
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-[var(--border)]">
          {sorted.map((c) => (
            <li key={c.name} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  <Badge tone={FLAG[c.flag].tone}>{FLAG[c.flag].label}</Badge>
                  <span className="text-xs text-[var(--fg-subtle)]">
                    {c.last_update_at
                      ? `Last update ${formatDate(c.last_update_at, tz)}`
                      : 'No update on record'}
                  </span>
                </div>
                {c.headline ? (
                  <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{c.headline}</p>
                ) : null}
                {c.asks.length > 0 ? (
                  <p className="mt-0.5 text-xs">
                    <span className="text-[var(--fg-subtle)]">Asks: </span>
                    {c.asks.join(' · ')}
                  </p>
                ) : null}
              </div>
              <GmailLink threadId={c.thread_id} label={`${c.name}'s latest update`} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- intros ------------------------------- */

const INTRO: Record<IntroItem['status'], { label: string; tone: BadgeProps['tone'] }> = {
  owed: { label: 'You owe this', tone: 'warn' },
  made: { label: 'Made', tone: 'info' },
  connected: { label: 'Connected', tone: 'ok' },
  stalled: { label: 'Stalled', tone: 'neutral' },
  declined: { label: 'Declined', tone: 'neutral' },
};
const INTRO_ORDER: IntroItem['status'][] = ['owed', 'made', 'stalled', 'connected', 'declined'];

export function IntrosCard({
  intros,
  now,
  empty = null,
  drafts = {},
  canSend = false,
}: {
  intros: Intros;
  now: Date;
  /** What to show when there is no intro. Nothing, by default. */
  empty?: ReactNode;
  /** "Write the intro" drafts for owed intros, by `introKey`; none, no button. */
  drafts?: Record<string, IntroDraft>;
  /** Whether the compose window may send from the mailbox (otherwise it offers Copy). */
  canSend?: boolean;
}) {
  if (intros.intros.length === 0) return empty;
  const sorted = [...intros.intros].sort(
    (a, b) => INTRO_ORDER.indexOf(a.status) - INTRO_ORDER.indexOf(b.status),
  );
  const owed = intros.intros.filter((i) => i.status === 'owed').length;
  return (
    <Card className="mb-6" data-tour="network-intros">
      <CardHeader>
        <div>
          <CardTitle>Intros</CardTitle>
          <p className="text-xs text-[var(--fg-subtle)]">
            {owed > 0 ? `${owed} you still owe · ` : ''}checked {relativeTime(intros.run_at, now)}
            <StaleHint feed="intros" checkedAt={intros.run_at} now={now} />
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-[var(--border)]">
          {sorted.map((i) => {
            const draft = i.status === 'owed' ? drafts[introKey(i)] : undefined;
            return (
              <li key={`${i.for_who}-${i.to_who}`} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {i.for_who} <span className="text-[var(--fg-subtle)]">→</span> {i.to_who}
                    </span>
                    <Badge tone={INTRO[i.status].tone}>{INTRO[i.status].label}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                    {i.made_at
                      ? `Made ${relativeTime(i.made_at, now)}`
                      : i.asked_at
                        ? `Asked ${relativeTime(i.asked_at, now)}`
                        : ''}
                    {i.note ? `${i.made_at || i.asked_at ? ' · ' : ''}${i.note}` : ''}
                  </p>
                  {draft ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <WriteIntroButton draft={draft} canSend={canSend} who={introKey(i)} />
                    </div>
                  ) : null}
                </div>
                <GmailLink
                  threadId={i.thread_id}
                  label={`the intro thread, ${i.for_who} to ${i.to_who}`}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ week ahead ----------------------------- */

const KIND_TONE: Record<WeekEvent['kind'], BadgeProps['tone']> = {
  founder: 'info',
  lp: 'ok',
  portfolio: 'ok',
  investor: 'info',
  internal: 'neutral',
  personal: 'neutral',
  other: 'neutral',
};
const KIND_LABEL: Record<WeekEvent['kind'], string> = {
  founder: 'Founder',
  lp: 'LP',
  portfolio: 'Portfolio',
  investor: 'Investor',
  internal: 'Internal',
  personal: 'Personal',
  other: 'Other',
};

/**
 * The week's events still to come, soonest first: what the card shows. A
 * weekly snapshot runs out before the next one posts (by the weekend, often).
 */
export function upcomingWeekEvents(week: WeekAhead, now: Date): WeekEvent[] {
  return week.events
    .filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() >= now.getTime())
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function WeekAheadCard({
  week,
  now,
  tz,
  empty = null,
}: {
  week: WeekAhead;
  now: Date;
  tz: string;
  /** What to show when nothing is still to come. Nothing, by default. */
  empty?: ReactNode;
}) {
  const upcoming = upcomingWeekEvents(week, now);
  if (upcoming.length === 0) return empty;
  const days = new Map<string, WeekEvent[]>();
  for (const e of upcoming) {
    const day = formatWeekdayLong(new Date(e.starts_at), tz);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <Card className="mb-6" data-tour="meetings-week">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-[var(--fg-subtle)]" aria-hidden />
          <div>
            <CardTitle>The week ahead</CardTitle>
            <Checked at={week.run_at} now={now} feed="week-ahead" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {[...days.entries()].map(([day, events]) => (
          <section key={day}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--fg-subtle)] uppercase">
              {day}
            </h3>
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={`${e.starts_at}-${e.title}`} className="flex items-start gap-3">
                  <span className="tabular w-16 shrink-0 text-sm font-semibold">
                    {formatTime(e.starts_at, tz)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{e.title}</span>
                      <Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Badge>
                    </div>
                    {e.with_who.length > 0 ? (
                      <p className="text-xs text-[var(--fg-subtle)]">
                        With {e.with_who.join(', ')}
                      </p>
                    ) : null}
                    {e.prep ? (
                      <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{e.prep}</p>
                    ) : null}
                  </div>
                  <GmailLink threadId={e.thread_id} label={`the thread for ${e.title}`} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ LP update ------------------------------ */

export function LpUpdateCard({ draft, now }: { draft: LpUpdateDraft; now: Date }) {
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-start justify-between gap-3 pt-4">
        <div className="flex items-start gap-3">
          <FileText className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" aria-hidden />
          <div>
            <p className="text-sm font-medium">
              {draft.status === 'drafted'
                ? `${draft.period} LP update drafted`
                : `${draft.period} LP update not drafted`}
            </p>
            <p className="text-xs text-[var(--fg-subtle)]">
              {relativeTime(draft.run_at, now)}
              {draft.sections.length > 0 ? ` · ${draft.sections.join(', ')}` : ''}
            </p>
            {draft.note ? (
              <p className="mt-1 text-sm text-[var(--fg-muted)]">{draft.note}</p>
            ) : null}
          </div>
        </div>
        {/* The draft's thread: read it in Kraken's Inbox, edit and send it in Gmail. */}
        <ThreadLinks
          id={draft.draft_thread_id}
          mailbox={DEFAULT_MAILBOX}
          label={`the ${draft.period} LP update draft`}
        />
      </CardContent>
    </Card>
  );
}
