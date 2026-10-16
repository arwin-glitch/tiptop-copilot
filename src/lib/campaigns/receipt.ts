/**
 * A campaign's receipt: how it went out, in the three numbers a sender wants
 * after a bulk email (when, how many reached people, how many need a look),
 * like the receipt Affinity emails after one. Pure, so the campaign page, the
 * finish toast, the campaign list and the phone alert all say the same thing.
 *
 *   delivered = sent - bounced   (Gmail took it and it did not bounce)
 *   issues    = failed + bounced + unconfirmed ("may have gone out")
 *
 * Skipped people (unsubscribed, added after the review, or cancelled) were
 * never sent and are not issues; they are why `delivered` can be short of
 * `total` with nothing to fix. A bounce counts once, as an issue, never also
 * as delivered.
 */

/** The counts a receipt reads; `bounced` is absent where only send counts are known. */
export interface ReceiptCounts {
  total: number;
  sent: number;
  failed: number;
  unconfirmed: number;
  skipped: number;
  pending: number;
  bounced?: number;
}

export interface CampaignReceipt {
  total: number;
  /** Gmail took it, bounced or not: how far the send got. */
  sent: number;
  delivered: number;
  issues: number;
  failed: number;
  bounced: number;
  unconfirmed: number;
  skipped: number;
  pending: number;
  /** Everyone on the campaign got it. */
  allDelivered: boolean;
}

const whole = (n: number | undefined) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

export function campaignReceipt(counts: ReceiptCounts): CampaignReceipt {
  const total = whole(counts.total);
  const sent = whole(counts.sent);
  const bounced = Math.min(whole(counts.bounced), sent);
  const failed = whole(counts.failed);
  const unconfirmed = whole(counts.unconfirmed);
  const delivered = sent - bounced;
  return {
    total,
    sent,
    delivered,
    issues: failed + bounced + unconfirmed,
    failed,
    bounced,
    unconfirmed,
    skipped: whole(counts.skipped),
    pending: whole(counts.pending),
    allDelivered: total > 0 && delivered === total,
  };
}

/**
 * The recipients filter that shows exactly who the Issues tile counts:
 * "Bounced or failed", "May have gone out", or, when there are both kinds,
 * "Needs a look" (all three). Null when there are no issues.
 */
export type IssuesFilter = 'problems' | 'unconfirmed' | 'issues';

export function issuesFilter(r: CampaignReceipt): IssuesFilter | null {
  if (!r.issues) return null;
  const problems = r.failed + r.bounced;
  if (problems && r.unconfirmed) return 'issues';
  return problems ? 'problems' : 'unconfirmed';
}

/** "1 needs a look", "3 need a look". */
export function needALook(n: number): string {
  return n === 1 ? '1 needs a look' : `${n} need a look`;
}

/** "no issues", "1 issue", "3 issues". */
export function issuesPhrase(n: number): string {
  return n === 0 ? 'no issues' : n === 1 ? '1 issue' : `${n} issues`;
}

/** A finished campaign, or one that stopped (cancelled) after some went out. */
export type ReceiptVariant = 'sent' | 'stopped';

/** The line above the receipt's tiles. */
export function receiptHeadline(r: CampaignReceipt, variant: ReceiptVariant = 'sent'): string {
  if (variant === 'stopped') {
    // How far the send got, bounces included: the "Sent N of total" stat's number.
    const base = `Stopped at ${r.sent} of ${r.total}`;
    return r.issues ? `${base}, ${needALook(r.issues)}` : base;
  }
  if (r.issues) return `Sent, ${needALook(r.issues)}`;
  if (r.allDelivered || r.total === 0) return 'Sent to everyone';
  return `Sent, ${r.total - r.delivered} skipped`;
}

/** What is short of everyone, for the Delivered tile: "1 bounced · 2 skipped". */
export function deliveredHint(r: CampaignReceipt): string {
  if (r.allDelivered) return 'Everyone on the list';
  const parts = [
    r.bounced ? `${r.bounced} bounced` : '',
    r.failed ? `${r.failed} failed` : '',
    r.unconfirmed ? `${r.unconfirmed} unconfirmed` : '',
    r.skipped ? `${r.skipped} skipped` : '',
    r.pending ? `${r.pending} not sent` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Nobody yet';
}

/** The issues, itemized: "1 bounced · 2 failed · 1 may have gone out". */
export function issuesHint(r: CampaignReceipt): string {
  if (!r.issues) return 'Nothing bounced or failed';
  return [
    r.bounced ? `${r.bounced} bounced` : '',
    r.failed ? `${r.failed} failed` : '',
    r.unconfirmed ? `${r.unconfirmed} may have gone out` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The toast when the last batch finishes, from that batch's own counts:
 * "Campaign sent: 106 of 106, no issues." / "Campaign sent: 104 of 106, 2 need a look."
 */
export function finishToast(counts: ReceiptCounts): string {
  const r = campaignReceipt(counts);
  const gap = r.total - r.delivered;
  const tail = r.issues
    ? needALook(r.issues)
    : gap > 0
      ? `no issues (${gap} skipped)`
      : issuesPhrase(0);
  return `Campaign sent: ${r.delivered} of ${r.total}, ${tail}.`;
}

/**
 * The phone alert's body line: "Q3 update · 106/106 · no issues". Only the
 * campaign's name and counts, never who it went to.
 */
export function receiptLine(name: string, counts: ReceiptCounts): string {
  const r = campaignReceipt(counts);
  return `${name} · ${r.delivered}/${r.total} · ${issuesPhrase(r.issues)}`;
}
