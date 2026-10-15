import type { Campaign, CampaignPauseReason } from '@/lib/types/domain';
import { DAILY_CAP, STALLED_AFTER_MS } from './limits';

/**
 * Where a campaign stands as a person should read it, which is more than its
 * status column: sending only happens while a page drives it, so a campaign
 * still marked "sending" that has done nothing for a couple of minutes has
 * stopped, and a pause says why. Pure: the list, the page and the progress
 * card all read it the same way.
 */
export type CampaignPhase =
  | 'draft'
  | 'sending'
  /** Marked sending, but no page is driving it (closed without the pause landing). */
  | 'stalled'
  | 'paused'
  /** Paused at the 24-hour cap. */
  | 'capped'
  | 'sent'
  | 'cancelled';

export function campaignPhase(
  campaign: Pick<Campaign, 'status' | 'pause_reason' | 'updated_at' | 'last_sent_at'>,
  now: Date = new Date(),
): CampaignPhase {
  if (campaign.status === 'paused') return campaign.pause_reason === 'capped' ? 'capped' : 'paused';
  if (campaign.status !== 'sending') return campaign.status;
  const last = Math.max(
    Date.parse(campaign.updated_at) || 0,
    Date.parse(campaign.last_sent_at ?? '') || 0,
  );
  return now.getTime() - last > STALLED_AFTER_MS ? 'stalled' : 'sending';
}

export const PHASE_LABEL: Record<CampaignPhase, string> = {
  draft: 'Draft',
  sending: 'Sending',
  stalled: 'Stopped',
  paused: 'Paused',
  capped: 'Daily limit',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

/** Why a campaign is paused, in a sentence for the page. */
export const PAUSE_REASON_TEXT: Record<CampaignPauseReason, string> = {
  manual: 'Paused. Nothing more goes out until you resume.',
  left: 'Paused when the sending page was left: sending only runs while that page is open. Nothing more goes out until you resume.',
  capped: `Paused at the daily limit of ${DAILY_CAP} emails in 24 hours. Resume once the next slot opens.`,
  failures:
    'Paused after several emails in a row did not send. Check the errors below, then resume.',
  refused:
    'Paused: Gmail refused to send. Sending may need to be turned on again in Settings, then resume.',
};

/** Unsubscribes this recent are called out above the list. */
export const RECENT_UNSUBSCRIBE_DAYS = 7;

/** How many of these happened in the last `days` days. */
export function countRecent(
  items: readonly { at: string }[],
  days: number = RECENT_UNSUBSCRIBE_DAYS,
  now: Date = new Date(),
): number {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items.filter((i) => Date.parse(i.at) >= since).length;
}

export const STALLED_TEXT =
  'Sending stopped: the page that was sending it was closed. Nothing more goes out until you continue.';
