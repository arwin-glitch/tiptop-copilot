'use client';

import * as React from 'react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Stat, StatGroup } from '@/components/ui/stat';
import { FilterChip, FilterChipRow } from '@/components/ui/toolbar';
import { ThreadLinks } from '@/components/email/thread-links';
import { campaignReceipt, issuesFilter, type ReceiptVariant } from '@/lib/campaigns/receipt';
import type { CampaignCounts, RecipientState } from '@/lib/services/campaigns';
import { CampaignReceipt } from './campaign-receipt';

export interface ReportRow {
  id: string;
  email: string;
  name: string | null;
  state: RecipientState;
  openCount: number;
  clickCount: number;
  /** The latest thing that happened, ISO. */
  lastAt: string | null;
  error: string | null;
  /** The sent email's Gmail thread, once they replied: their reply is read there. */
  replyThreadId?: string | null;
}

const STATE_LABEL: Record<RecipientState, string> = {
  replied: 'Replied',
  clicked: 'Clicked',
  opened: 'Opened',
  sent: 'Sent',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  failed: 'Failed',
  unconfirmed: 'May have gone out',
  skipped: 'Skipped',
  pending: 'Not sent yet',
};

const STATE_TONE: Record<RecipientState, NonNullable<BadgeProps['tone']>> = {
  replied: 'ok',
  clicked: 'accent',
  opened: 'info',
  sent: 'neutral',
  bounced: 'danger',
  unsubscribed: 'outline',
  failed: 'danger',
  unconfirmed: 'warn',
  skipped: 'outline',
  pending: 'outline',
};

type Filter =
  'all' | 'opened' | 'clicked' | 'replied' | 'unopened' | 'problems' | 'unconfirmed' | 'issues';

const FILTERS: { key: Filter; label: string; test: (r: ReportRow) => boolean; tracked?: true }[] = [
  { key: 'all', label: 'Everyone', test: () => true },
  {
    key: 'opened',
    label: 'Opened',
    test: (r) => r.openCount > 0 || ['opened', 'clicked', 'replied'].includes(r.state),
    tracked: true,
  },
  { key: 'clicked', label: 'Clicked', test: (r) => r.clickCount > 0, tracked: true },
  { key: 'replied', label: 'Replied', test: (r) => r.state === 'replied' },
  { key: 'unopened', label: 'Not opened', test: (r) => r.state === 'sent', tracked: true },
  {
    key: 'problems',
    label: 'Bounced or failed',
    test: (r) => r.state === 'bounced' || r.state === 'failed',
  },
  { key: 'unconfirmed', label: 'May have gone out', test: (r) => r.state === 'unconfirmed' },
  // The receipt's Issues tile, when it counts both kinds: everyone it counts.
  {
    key: 'issues',
    label: 'Needs a look',
    test: (r) => r.state === 'bounced' || r.state === 'failed' || r.state === 'unconfirmed',
  },
];

const PAGE = 100;

const pct = (part: number, sent: number) => (sent > 0 ? Math.round((part / sent) * 100) : null);

/**
 * How a campaign landed: the receipt (once it finished), the rates, then
 * everyone and where they stand.
 */
export function CampaignReport({
  counts,
  rows,
  timezone,
  tracking = true,
  receipt = null,
  progress = null,
  mailbox = null,
}: {
  counts: CampaignCounts;
  rows: ReportRow[];
  timezone: string;
  /** The mailbox the campaign sent from, for the reply links' Gmail side. */
  mailbox?: string | null;
  /** Whether opens and clicks were tracked for this campaign. */
  tracking?: boolean;
  /** Finished (or stopped after some went out): the receipt up top, and when. */
  receipt?: { variant: ReceiptVariant; at: string | null; now: string } | null;
  /** The sending card, between the receipt and the rates. */
  progress?: React.ReactNode;
}) {
  const [filter, setFilter] = React.useState<Filter>('all');
  const [shown, setShown] = React.useState(PAGE);
  const peopleRef = React.useRef<HTMLElement>(null);
  const summary = campaignReceipt(counts);
  // Which chip the Issues tile opens. "Needs a look" is a chip only when the
  // issues are of both kinds; otherwise one of the two chips already is
  // exactly who the tile counts.
  const issuesKey = issuesFilter(summary);
  const filters = FILTERS.filter(
    (f) =>
      (tracking || !f.tracked) &&
      (f.key !== 'unconfirmed' || counts.unconfirmed > 0) &&
      (f.key !== 'issues' || (receipt !== null && issuesKey === 'issues')),
  );
  const test = filters.find((f) => f.key === filter)?.test ?? (() => true);
  const visible = rows.filter(test);
  const opened = pct(counts.opened, counts.sent);
  const clicked = pct(counts.clicked, counts.sent);
  const replied = pct(counts.replied, counts.sent);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  /** The receipt's Issues tile: the list below, filtered to everyone it counts. */
  const showIssues = () => {
    if (!issuesKey) return;
    setFilter(issuesKey);
    setShown(PAGE);
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    peopleRef.current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-5">
      {receipt ? (
        <CampaignReceipt
          receipt={summary}
          variant={receipt.variant}
          at={receipt.at}
          now={receipt.now}
          timezone={timezone}
          onShowIssues={showIssues}
        />
      ) : null}
      {progress}
      <StatGroup columns={4}>
        <Stat size="sm" label="Sent" value={counts.sent} hint={`of ${counts.total}`} />
        <Stat
          size="sm"
          label="Opened"
          value={!tracking ? null : opened === null ? null : `${opened}%`}
          unknownLabel={tracking ? '–' : 'Off'}
          hint={tracking ? `${counts.opened} people` : 'Not tracked'}
        />
        <Stat
          size="sm"
          label="Clicked"
          value={!tracking ? null : clicked === null ? null : `${clicked}%`}
          unknownLabel={tracking ? '–' : 'Off'}
          hint={tracking ? `${counts.clicked} people` : 'Not tracked'}
        />
        <Stat
          size="sm"
          label="Replied"
          value={replied === null ? null : `${replied}%`}
          unknownLabel="–"
          hint={`${counts.bounced} bounced · ${counts.failed} failed`}
        />
      </StatGroup>
      <p className="text-xs text-[var(--fg-subtle)]">
        {tracking
          ? 'Opens and clicks are estimates. An open counts when the email’s images load: some mail apps load them on their own, careful readers may never, and opening a campaign email from Sent in Gmail counts too. Link checks by mail scanners are left out where they can be told apart (in the first minute after sending, or several links at once). '
          : 'Opens and clicks were not tracked for this campaign. '}
        Replies and bounces are read from the synced inbox; out-of-office replies are not counted.
      </p>

      <section ref={peopleRef} aria-labelledby="report-people" className="scroll-mt-20 space-y-3">
        <h2 id="report-people" className="font-serif text-lg font-semibold">
          Recipients
        </h2>
        <FilterChipRow aria-label="Show recipients">
          {filters.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              count={rows.filter(f.test).length}
              pressed={filter === f.key}
              onToggle={() => {
                setFilter(f.key);
                setShown(PAGE);
              }}
            />
          ))}
        </FilterChipRow>
        {visible.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">Nobody here.</p>
        ) : (
          <ul
            aria-label="Recipient results"
            className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
          >
            {visible.slice(0, shown).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name ?? r.email}</p>
                  {r.name ? (
                    <p className="truncate text-xs text-[var(--fg-muted)]">{r.email}</p>
                  ) : null}
                  {/* Whole, never cut off: it says what happened and what to do. */}
                  {r.error ? (
                    <p className="text-xs break-words text-[var(--fg-muted)]">{r.error}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-subtle)]">
                  {r.openCount ? (
                    <span className="tabular">
                      {r.openCount} {r.openCount === 1 ? 'open' : 'opens'}
                    </span>
                  ) : null}
                  {r.clickCount ? (
                    <span className="tabular">
                      {r.clickCount} {r.clickCount === 1 ? 'click' : 'clicks'}
                    </span>
                  ) : null}
                  {r.lastAt ? <span className="hidden sm:inline">{fmt(r.lastAt)}</span> : null}
                  <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                  {/* Their reply, in Kraken's Inbox or in Gmail. */}
                  {r.state === 'replied' ? (
                    <ThreadLinks
                      id={r.replyThreadId}
                      mailbox={mailbox}
                      label={`the reply from ${r.name ?? r.email}`}
                      variant="icons"
                      className="-my-1"
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {visible.length > shown ? (
          <Button
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => setShown((n) => n + PAGE)}
          >
            Show {Math.min(PAGE, visible.length - shown)} more
          </Button>
        ) : null}
      </section>
    </div>
  );
}
