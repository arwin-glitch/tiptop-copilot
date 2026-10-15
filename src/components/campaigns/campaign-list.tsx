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
import { PHASE_LABEL, campaignPhase, type CampaignPhase } from '@/lib/campaigns/status';
import type { CampaignSummary } from '@/lib/services/campaigns';
import { formatDate } from '@/lib/util/time';
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
                    <span>{formatDate(when, timezone)}</span>
                    {c.status === 'draft' ? (
                      <span>
                        · {total} {total === 1 ? 'person' : 'people'}
                      </span>
                    ) : null}
                    {unconfirmed ? <span>· {unconfirmed} to check</span> : null}
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
