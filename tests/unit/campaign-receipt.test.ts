import { describe, expect, it } from 'vitest';
import {
  campaignReceipt,
  deliveredHint,
  finishToast,
  issuesFilter,
  issuesHint,
  issuesPhrase,
  receiptHeadline,
  receiptLine,
  type ReceiptCounts,
} from '@/lib/campaigns/receipt';

/** The receipt after a bulk send: delivered, issues, and how each is worded. */

const CLEAN: ReceiptCounts = {
  total: 106,
  sent: 106,
  failed: 0,
  unconfirmed: 0,
  skipped: 0,
  pending: 0,
  bounced: 0,
};

describe('the receipt counts', () => {
  it('a clean send: everyone delivered, no issues', () => {
    const r = campaignReceipt(CLEAN);
    expect(r).toMatchObject({ total: 106, delivered: 106, issues: 0, allDelivered: true });
    expect(receiptHeadline(r)).toBe('Sent to everyone');
    expect(deliveredHint(r)).toBe('Everyone on the list');
    expect(issuesHint(r)).toBe('Nothing bounced or failed');
  });

  it('issues are failed + bounced + may have gone out, and a bounce is never also delivered', () => {
    const r = campaignReceipt({ ...CLEAN, sent: 103, failed: 2, unconfirmed: 1, bounced: 1 });
    expect(r.delivered).toBe(102);
    expect(r.issues).toBe(4);
    expect(r.allDelivered).toBe(false);
    expect(receiptHeadline(r)).toBe('Sent, 4 need a look');
    expect(issuesHint(r)).toBe('1 bounced · 2 failed · 1 may have gone out');
    expect(deliveredHint(r)).toBe('1 bounced · 2 failed · 1 unconfirmed');
    // Delivered, issues and skipped account for everyone.
    expect(r.delivered + r.issues + r.skipped + r.pending).toBe(r.total);
  });

  it('one issue reads in the singular', () => {
    const r = campaignReceipt({ ...CLEAN, total: 8, sent: 8, bounced: 1 });
    expect(r).toMatchObject({ delivered: 7, issues: 1 });
    expect(receiptHeadline(r)).toBe('Sent, 1 needs a look');
    expect(issuesPhrase(1)).toBe('1 issue');
    expect(issuesPhrase(0)).toBe('no issues');
    expect(issuesPhrase(3)).toBe('3 issues');
  });

  it('skipped people are not issues, but keep it from reading "everyone"', () => {
    const r = campaignReceipt({ ...CLEAN, sent: 104, skipped: 2 });
    expect(r).toMatchObject({ delivered: 104, issues: 0, allDelivered: false });
    expect(receiptHeadline(r)).toBe('Sent, 2 skipped');
    expect(deliveredHint(r)).toBe('2 skipped');
  });

  it('a cancelled send reads as stopped where it got to', () => {
    const stopped = campaignReceipt({ ...CLEAN, sent: 40, skipped: 66 });
    expect(receiptHeadline(stopped, 'stopped')).toBe('Stopped at 40 of 106');
    const withIssue = campaignReceipt({ ...CLEAN, sent: 40, failed: 1, skipped: 65 });
    expect(receiptHeadline(withIssue, 'stopped')).toBe('Stopped at 40 of 106, 1 needs a look');
    // Bounces that come in later do not move where it stopped (the Sent stat's 40).
    const bounced = campaignReceipt({ ...CLEAN, sent: 40, bounced: 2, skipped: 66 });
    expect(bounced).toMatchObject({ sent: 40, delivered: 38, issues: 2 });
    expect(receiptHeadline(bounced, 'stopped')).toBe('Stopped at 40 of 106, 2 need a look');
  });

  it('the Issues tile opens the filter that holds exactly who it counts', () => {
    expect(issuesFilter(campaignReceipt(CLEAN))).toBeNull();
    const bounced = campaignReceipt({ ...CLEAN, bounced: 1 });
    expect(issuesFilter(bounced)).toBe('problems');
    const failed = campaignReceipt({ ...CLEAN, sent: 105, failed: 1 });
    expect(issuesFilter(failed)).toBe('problems');
    const unsure = campaignReceipt({ ...CLEAN, sent: 104, unconfirmed: 2 });
    expect(issuesFilter(unsure)).toBe('unconfirmed');
    // Both kinds: "Needs a look", all of them, so the list matches the tile's 3.
    const mixed = campaignReceipt({ ...CLEAN, sent: 104, bounced: 1, unconfirmed: 2 });
    expect(mixed.issues).toBe(3);
    expect(issuesFilter(mixed)).toBe('issues');
  });

  it('works without a bounce count, and never trusts odd numbers', () => {
    const noBounce: ReceiptCounts = { ...CLEAN, bounced: undefined };
    expect(campaignReceipt(noBounce)).toMatchObject({ delivered: 106, bounced: 0, issues: 0 });
    // More bounces than sends cannot happen; it never goes negative.
    const odd = campaignReceipt({ ...CLEAN, total: 2, sent: 1, bounced: 5, failed: -1 });
    expect(odd).toMatchObject({ delivered: 0, bounced: 1, failed: 0, issues: 1 });
  });
});

describe('the finish toast and the alert line', () => {
  it('says the real numbers', () => {
    expect(finishToast(CLEAN)).toBe('Campaign sent: 106 of 106, no issues.');
    expect(finishToast({ ...CLEAN, sent: 104, failed: 2 })).toBe(
      'Campaign sent: 104 of 106, 2 need a look.',
    );
    expect(finishToast({ ...CLEAN, sent: 105, unconfirmed: 1 })).toBe(
      'Campaign sent: 105 of 106, 1 needs a look.',
    );
    expect(finishToast({ ...CLEAN, sent: 104, skipped: 2 })).toBe(
      'Campaign sent: 104 of 106, no issues (2 skipped).',
    );
  });

  it('the phone alert line is the name and counts only', () => {
    expect(receiptLine('Q4 update', CLEAN)).toBe('Q4 update · 106/106 · no issues');
    expect(receiptLine('Q4 update', { ...CLEAN, sent: 104, failed: 2 })).toBe(
      'Q4 update · 104/106 · 2 issues',
    );
  });
});
