import Link from 'next/link';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { SectionHeading } from '@/components/shell/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { campaignReceipt, issuesPhrase } from '@/lib/campaigns/receipt';
import { PHASE_LABEL, campaignPhase, type CampaignPhase } from '@/lib/campaigns/status';
import type { CampaignSummary } from '@/lib/services/campaigns';
import { formatDate, formatMonthDay } from '@/lib/util/time';
import { NewCampaignButton } from './new-campaign-button';

export const PHASE_TONE: Record<CampaignPhase, NonNullable<BadgeProps['tone']>> = {
  draft: 'neutral',
  sending: 'info',
  stalled: 'warn',
  paused: 'warn',
  capped: 'warn',
  sent: 'ok',
  cancelled: 'outline',
};

const pct = (part: number, sent: number) =>
  sent > 0 ? `${Math.round((part / sent) * 100)}%` : '–';

const yearOf = (date: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(date));

/** Every campaign, newest first: how many it went to and how they responded. */
export function CampaignList({
  campaigns,
  timezone,
  now = new Date(),
}: {
  campaigns: CampaignSummary[];
  timezone: string;
  now?: Date;
}) {
  if (campaigns.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No campaigns yet"
          description="Send an LP update or an SPV offering as one personal email per person from your mailbox, then see who opened, clicked and replied."
        />
        <div className="flex justify-center">
          <NewCampaignButton size="md" />
        </div>
      </div>
    );
  }
  return (
    <section aria-labelledby="campaigns-heading">
      <SectionHeading count={campaigns.length} action={<NewCampaignButton />}>
        <span id="campaigns-heading">Campaigns</span>
      </SectionHeading>
      <Table caption="Campaigns">
        <TableHead>
          <tr>
            <TableHeaderCell>Campaign</TableHeaderCell>
            <TableHeaderCell numeric>Sent</TableHeaderCell>
            <TableHeaderCell numeric>Opened</TableHeaderCell>
            <TableHeaderCell numeric className="hidden sm:table-cell">
              Clicked
            </TableHeaderCell>
            <TableHeaderCell numeric>Replied</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {campaigns.map((c) => {
            const { sent, opened, clicked, replied, total, unconfirmed } = c.counts;
            const when = c.sent_at ?? c.confirmed_at ?? c.created_at;
            const phase = campaignPhase(c, now);
            // A finished one reads like its receipt: "Sent Oct 16 · 106/106".
            const receipt = c.status === 'sent' ? campaignReceipt(c.counts) : null;
            const sameYear = yearOf(when, timezone) === yearOf(now, timezone);
            return (
              <TableRow key={c.id} interactive>
                <TableRowHeader className="min-w-44">
                  <Link
                    href={`/fund-ii/campaigns/${c.id}`}
                    className="font-medium hover:text-[var(--accent)] hover:underline"
                  >
                    {c.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-normal text-[var(--fg-subtle)]">
                    <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>
                    {receipt ? (
                      <>
                        <span>
                          {sameYear ? formatMonthDay(when, timezone) : formatDate(when, timezone)}
                        </span>
                        <span
                          className="tabular"
                          title={`${receipt.delivered} of ${receipt.total} delivered`}
                        >
                          · {receipt.delivered}/{receipt.total}
                        </span>
                        {receipt.issues ? (
                          <Badge tone="warn">{issuesPhrase(receipt.issues)}</Badge>
                        ) : null}
                      </>
                    ) : (
                      <span>{formatDate(when, timezone)}</span>
                    )}
                    {c.status === 'draft' ? (
                      <span>
                        · {total} {total === 1 ? 'person' : 'people'}
                      </span>
                    ) : null}
                    {unconfirmed && !receipt ? <span>· {unconfirmed} to check</span> : null}
                  </div>
                </TableRowHeader>
                <TableCell numeric>{c.status === 'draft' ? '–' : sent}</TableCell>
                <TableCell numeric>{c.track_activity ? pct(opened, sent) : 'off'}</TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  {c.track_activity ? pct(clicked, sent) : 'off'}
                </TableCell>
                <TableCell numeric>{pct(replied, sent)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
