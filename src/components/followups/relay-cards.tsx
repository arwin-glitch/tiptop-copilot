import { CalendarDays, ExternalLink, FileText } from 'lucide-react';
import { gmailThreadUrl } from '@/lib/deals/links';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type {
  IntroItem,
  Intros,
  LpUpdateDraft,
  PortfolioHealth,
  PortfolioHealthItem,
  WeekAhead,
  WeekEvent,
} from '@/lib/services/follow-ups';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { formatDate, formatTime, formatWeekdayLong, relativeTime } from '@/lib/util/time';

/**
 * Cards for the routines' snapshots in #deal-relay. Plain text only; every
 * link is rebuilt from a validated Gmail thread id, never taken from a post.
 */

function GmailLink({ threadId, label }: { threadId: string | null | undefined; label: string }) {
  const href = threadId ? gmailThreadUrl(threadId, DEFAULT_MAILBOX) : null;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="mt-0.5 shrink-0 text-[var(--accent)]"
    >
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function Checked({ at, now }: { at: string; now: Date }) {
  return <p className="text-xs text-[var(--fg-subtle)]">Checked {relativeTime(at, now)}</p>;
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
}: {
  health: PortfolioHealth;
  now: Date;
  tz: string;
}) {
  if (health.companies.length === 0) return null;
  const sorted = [...health.companies].sort(
    (a, b) => FLAG_ORDER.indexOf(a.flag) - FLAG_ORDER.indexOf(b.flag),
  );
  return (
    <Card className="mb-8">
      <CardHeader>
        <div>
          <CardTitle>Portfolio health</CardTitle>
          <Checked at={health.run_at} now={now} />
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
              <GmailLink threadId={c.thread_id} label={`Open ${c.name}'s latest update in Gmail`} />
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

export function IntrosCard({ intros, now }: { intros: Intros; now: Date }) {
  if (intros.intros.length === 0) return null;
  const sorted = [...intros.intros].sort(
    (a, b) => INTRO_ORDER.indexOf(a.status) - INTRO_ORDER.indexOf(b.status),
  );
  const owed = intros.intros.filter((i) => i.status === 'owed').length;
  return (
    <Card className="mb-6">
      <CardHeader>
        <div>
          <CardTitle>Intros</CardTitle>
          <p className="text-xs text-[var(--fg-subtle)]">
            {owed > 0 ? `${owed} you still owe · ` : ''}checked {relativeTime(intros.run_at, now)}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-[var(--border)]">
          {sorted.map((i) => (
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
              </div>
              <GmailLink threadId={i.thread_id} label={`Open the intro thread in Gmail`} />
            </li>
          ))}
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

export function WeekAheadCard({ week, now, tz }: { week: WeekAhead; now: Date; tz: string }) {
  const upcoming = week.events
    .filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() >= now.getTime())
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (upcoming.length === 0) return null;
  const days = new Map<string, WeekEvent[]>();
  for (const e of upcoming) {
    const day = formatWeekdayLong(new Date(e.starts_at), tz);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-[var(--fg-subtle)]" aria-hidden />
          <div>
            <CardTitle>The week ahead</CardTitle>
            <Checked at={week.run_at} now={now} />
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
                  <GmailLink
                    threadId={e.thread_id}
                    label={`Open the thread for ${e.title} in Gmail`}
                  />
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
  const href = draft.draft_thread_id
    ? gmailThreadUrl(draft.draft_thread_id, DEFAULT_MAILBOX)
    : null;
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
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Open the draft in Gmail
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
