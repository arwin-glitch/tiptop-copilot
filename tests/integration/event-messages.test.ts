import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoCampaignSender } from '@/lib/campaigns/demo-sender';
import { readTrackingToken } from '@/lib/campaigns/tokens';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { AudienceMember, NeedsNotifyingGroup } from '@/lib/events/contracts';
import { LocalStorageProvider } from '@/lib/storage/provider';
import {
  confirmCampaign,
  createCampaign,
  getCampaign,
  recordClick,
  reviewCampaign,
  sendBatch,
  sendTest,
  updateCampaign,
} from '@/lib/services/campaigns';
import {
  draftEventMessage,
  eventMessagesView,
  readMeta,
  updateEventComms,
} from '@/lib/services/event-comms';
import * as guests from '@/lib/services/event-guests';
import { getEvent, getEventSessions, type EventOwner } from '@/lib/services/events';
import { eventOverview, todayEventLines } from '@/lib/services/event-overview';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Event messages end to end on the demo store (D-075): a draft is an ordinary
 * campaign with the event's words and each guest's personal {{rsvp_link}};
 * nothing sends until the campaign is confirmed and a batch runs, exactly as
 * for any campaign; the click allowlist takes a recipient's own RSVP link and
 * nobody else's; a notice's status changes are marked told only after it has
 * sent. WS4's guest service is stubbed in the contract, so its three calls are
 * mocked here with fictional guests.
 */

vi.mock('@/lib/services/event-guests', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/event-guests')>();
  return {
    ...actual,
    resolveAudience: vi.fn(),
    needsNotifying: vi.fn(),
    markNotified: vi.fn(),
  };
});

// The guest list above is fictional, so the send-time check that each
// personal link is still the guest's current one (event-campaign-links.ts,
// covered in tests/unit/events-review-fixes.test.ts) is answered as current.
vi.mock('@/lib/services/event-campaign-links', () => ({
  eventLinkCheck: vi.fn(async () => ({ live: true, stale: 0, changedStatus: 0 })),
}));

const EVENT = DEMO_EVENT_IDS.annualMeeting;
const APP = 'https://copilot.example';
const MAIL_APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function member(n: number, guestId: string): AudienceMember {
  const first = ['Avery', 'Bianca', 'Carlos'][n] ?? 'Guest';
  return {
    guestId,
    email: `${first.toLowerCase()}@example.com`,
    firstName: first,
    name: `${first} Example`,
    company: 'Northwind Capital',
    recordId: null,
    rsvpPath: `/e/harborview-annual-meeting/i/tok_${first}0123456789abcdef`,
  };
}

const MEMBERS = [member(0, DEMO_EVENT_IDS.guestAvery), member(1, DEMO_EVENT_IDS.guestBianca)];

let h: Harness;
let owner: EventOwner;
let org: string;

beforeEach(async () => {
  h = await createHarness();
  org = h.auth.organizationId;
  owner = { userId: h.auth.userId, organizationId: org, name: 'Demo Owner' };
  vi.mocked(guests.resolveAudience).mockReset().mockResolvedValue(ok(MEMBERS));
  vi.mocked(guests.needsNotifying).mockReset().mockResolvedValue(ok([]));
  vi.mocked(guests.markNotified)
    .mockReset()
    .mockResolvedValue(ok({ updated: 0 }));
});

afterEach(async () => {
  await h.dispose();
});

async function draft(body: Record<string, unknown>) {
  const result = await draftEventMessage(h.store, owner, EVENT, body, { appUrl: APP });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function sendAll(campaignId: string, sender = new DemoCampaignSender()) {
  const review = await reviewCampaign(h.store, org, campaignId);
  if (!review.ok) throw new Error(review.error.message);
  expect(review.value.issues).toEqual([]);
  const confirmed = await confirmCampaign(h.store, org, campaignId, owner, {
    version: review.value.version,
    recipients: review.value.recipientCount,
    subject: review.value.campaign.subject,
    from: review.value.campaign.from_identity,
    track: review.value.campaign.track_activity,
    unsubscribe: review.value.campaign.unsubscribe_link,
  });
  if (!confirmed.ok) throw new Error(confirmed.error.message);
  const batch = await sendBatch(h.store, org, campaignId, {
    sender,
    storage: new LocalStorageProvider(),
    appUrl: APP,
    sleep: async () => {},
    intervalMs: 0,
  });
  if (!batch.ok) throw new Error(batch.error.message);
  return sender;
}

describe('drafting an invite', () => {
  it('makes a campaign draft in the event’s words, each guest with their own link, and sends nothing', async () => {
    const result = await draft({ kind: 'invite' });
    expect(result).toMatchObject({ added: 2, notLive: false });
    expect(vi.mocked(guests.resolveAudience)).toHaveBeenCalledWith(h.store, org, EVENT, {
      kind: 'status',
      statuses: ['invited'],
    });
    const detail = await getCampaign(h.store, org, result.campaignId);
    if (!detail.ok) throw new Error(detail.error.message);
    const { campaign, recipients } = detail.value;
    expect(campaign).toMatchObject({
      status: 'draft',
      event_id: EVENT,
      event_kind: 'invite',
      from_identity: 'nick',
      subject: "You're invited: Harborview Annual Meeting",
      name: 'Harborview Annual Meeting · Invite',
    });
    expect(campaign.body_template).toContain('{{rsvp_link|RSVP here}}');
    expect(readMeta(campaign.event_meta).audienceLabel).toBe('Invited, no reply');
    expect(recipients.map((r) => r.merge.rsvp_link)).toEqual([
      `${APP}/e/harborview-annual-meeting/i/tok_Avery0123456789abcdef`,
      `${APP}/e/harborview-annual-meeting/i/tok_Bianca0123456789abcdef`,
    ]);
    expect(recipients.every((r) => r.status === 'pending' && r.attempted_at === null)).toBe(true);
    const audit = await h.store.list('audit_events', org, {
      eq: { action: 'event.campaign_drafted', entity_id: EVENT },
    });
    expect(audit).toHaveLength(1);
  });

  it('sends only after the confirmation, with each guest’s own tracked link that only they can follow', async () => {
    const { campaignId } = await draft({ kind: 'invite', sender: 'arwin' });
    const sender = await sendAll(campaignId);
    expect(sender.sent).toHaveLength(2);
    const detail = await getCampaign(h.store, org, campaignId);
    if (!detail.ok) throw new Error(detail.error.message);
    const [avery, bianca] = detail.value.recipients;
    const averyEmail = sender.sent.find((e) => e.to.includes('avery@example.com'))!;
    const click =
      /href="https:\/\/copilot\.example\/t\/c\/([^"?]+)\?u=([^"]+)" target="_blank">RSVP here<\/a>/.exec(
        averyEmail.html,
      );
    expect(click).toBeTruthy();
    const [, token, encoded] = click as RegExpExecArray;
    const target = readTrackingToken(token);
    expect(target?.recipientId).toBe(avery!.id);
    const url = decodeURIComponent((encoded as string).replace(/&amp;/g, '&'));
    expect(url).toBe(avery!.merge.rsvp_link);
    const later = new Date(Date.now() + 10 * 60_000);
    const followed = await recordClick(h.store, target!, url, { userAgent: MAIL_APP, now: later });
    expect(followed.ok && followed.value).toBe(url);
    // Bianca's link through Avery's token, or any other address: refused.
    for (const other of [
      bianca!.merge.rsvp_link!,
      `${url}x`,
      'https://evil.example/e/x/i/abcdefgh',
    ]) {
      const refused = await recordClick(h.store, target!, other, {
        userAgent: MAIL_APP,
        now: later,
      });
      expect(refused.ok, other).toBe(false);
    }
  });

  it('keeps every guest’s link out of a test email', async () => {
    const { campaignId } = await draft({ kind: 'invite' });
    const sender = new DemoCampaignSender();
    const sent = await sendTest(h.store, org, campaignId, {
      sender,
      storage: new LocalStorageProvider(),
      appUrl: APP,
      to: 'arwin@tiptop.example',
      actor: owner,
    });
    expect(sent.ok).toBe(true);
    const email = sender.sent[0]!;
    expect(email.html).not.toContain('/e/harborview-annual-meeting/i/');
    expect(email.text).not.toContain('/e/harborview-annual-meeting/i/');
    expect(email.html).toContain('RSVP here');
  });

  it('leaves a draft with nobody on it when no guest matches, which the review will not send', async () => {
    vi.mocked(guests.resolveAudience).mockResolvedValue(ok([]));
    const { campaignId, added } = await draft({
      kind: 'blast',
      audience: { kind: 'tag', tag: 'Press' },
    });
    expect(added).toBe(0);
    const review = await reviewCampaign(h.store, org, campaignId);
    expect(review.ok && review.value.issues).toContain('Add at least one recipient.');
  });

  it('drops a guest whose link is not a personal RSVP link', async () => {
    vi.mocked(guests.resolveAudience).mockResolvedValue(
      ok([MEMBERS[0]!, { ...MEMBERS[1]!, rsvpPath: '/somewhere/else' }]),
    );
    const result = await draft({ kind: 'invite' });
    expect(result.added).toBe(1);
    expect(result.left.invalid).toBe(1);
  });

  it('refuses what it cannot draft', async () => {
    const bad = [
      { kind: 'shout' },
      { kind: 'blast' },
      { kind: 'reminder' },
      { kind: 'notice' },
      { kind: 'invite', audience: { kind: 'tag', tag: '<script>' } },
      { kind: 'invite', extra: true },
    ];
    for (const body of bad) {
      const result = await draftEventMessage(h.store, owner, EVENT, body, { appUrl: APP });
      expect(result.ok, JSON.stringify(body)).toBe(false);
    }
    const unknown = await draftEventMessage(
      h.store,
      owner,
      '00000000-0000-4000-8000-00000000ffff',
      { kind: 'invite' },
      { appUrl: APP },
    );
    expect(unknown.ok).toBe(false);
  });
});

describe('the review of {{rsvp_link}}', () => {
  it('refuses it in a campaign that was not drafted from an event', async () => {
    const created = await createCampaign(h.store, org, owner, { name: 'Plain' });
    if (!created.ok) throw new Error(created.error.message);
    await updateCampaign(h.store, org, created.value.id, {
      subject: 'Hello',
      body_template: 'Hi {{first_name|there}}, {{rsvp_link|RSVP}}',
    });
    const review = await reviewCampaign(h.store, org, created.value.id);
    expect(review.ok && review.value.issues).toContain(
      '{{rsvp_link}} only works in a message drafted from an event (Events, then Messages).',
    );
  });

  it('refuses a recipient with no link, and a local address', async () => {
    const { campaignId } = await draft({ kind: 'invite' });
    const local = await reviewCampaign(h.store, org, campaignId, { appUrl: null });
    expect(local.ok && local.value.issues.join(' ')).toMatch(/personal RSVP links/);
    // Someone pasted by hand has no personal link.
    const { addRecipientsFromPaste } = await import('@/lib/services/campaigns');
    await addRecipientsFromPaste(h.store, org, campaignId, 'someone@example.com');
    const review = await reviewCampaign(h.store, org, campaignId);
    expect(review.ok && review.value.issues.join(' ')).toMatch(
      /1 recipient has no personal RSVP link/,
    );
  });
});

describe('needs notifying', () => {
  const group: NeedsNotifyingGroup = {
    kind: 'confirmed',
    items: [
      {
        guestId: DEMO_EVENT_IDS.guestAvery,
        sessionId: DEMO_EVENT_IDS.sessionReception,
        status: 'going',
      },
    ],
  };

  it('drafts one notice per status, then marks it told only after it has sent', async () => {
    vi.mocked(guests.needsNotifying).mockResolvedValue(ok([group]));
    vi.mocked(guests.resolveAudience).mockResolvedValue(ok([MEMBERS[0]!]));
    const event = await getEvent(h.store, org, EVENT);
    const sessions = await getEventSessions(h.store, org, EVENT);
    if (!event.ok || !sessions.ok) throw new Error('fixtures');

    const before = await eventMessagesView(h.store, org, event.value, sessions.value);
    expect(before.queue).toEqual([
      { kind: 'confirmed', open: [{ ...group.items[0], email: null }], draft: null },
    ]);

    const { campaignId } = await draft({ kind: 'notice', notifyKind: 'confirmed' });
    const drafted = await eventMessagesView(h.store, org, event.value, sessions.value);
    expect(drafted.queue).toEqual([
      { kind: 'confirmed', open: [], draft: { campaignId, count: 1 } },
    ]);
    // A second draft for the same people is refused.
    const again = await draftEventMessage(
      h.store,
      owner,
      EVENT,
      { kind: 'notice', notifyKind: 'confirmed' },
      { appUrl: APP },
    );
    expect(again.ok).toBe(false);
    expect(vi.mocked(guests.markNotified)).not.toHaveBeenCalled();

    await sendAll(campaignId);
    await eventMessagesView(h.store, org, event.value, sessions.value);
    expect(vi.mocked(guests.markNotified)).toHaveBeenCalledWith(h.store, org, EVENT, [
      group.items[0],
    ]);
    const detail = await getCampaign(h.store, org, campaignId);
    expect(detail.ok && readMeta(detail.value.campaign.event_meta).reconciledAt).toBeTruthy();
    // Finished: not looked at again.
    await eventMessagesView(h.store, org, event.value, sessions.value);
    expect(vi.mocked(guests.markNotified)).toHaveBeenCalledTimes(1);
  });
});

describe('reminders and the schedule', () => {
  it('drafts a reminder for one session and offset, to its going guests', async () => {
    const { campaignId } = await draft({
      kind: 'reminder',
      sessionId: DEMO_EVENT_IDS.sessionReception,
      offsetMinutes: 1_440,
    });
    expect(vi.mocked(guests.resolveAudience)).toHaveBeenLastCalledWith(h.store, org, EVENT, {
      kind: 'status',
      statuses: ['going'],
      sessionId: DEMO_EVENT_IDS.sessionReception,
    });
    const event = await getEvent(h.store, org, EVENT);
    const sessions = await getEventSessions(h.store, org, EVENT);
    if (!event.ok || !sessions.ok) throw new Error('fixtures');
    const view = await eventMessagesView(h.store, org, event.value, sessions.value);
    const slot = view.reminders.find(
      (s) => s.sessionId === DEMO_EVENT_IDS.sessionReception && s.offsetMinutes === 1_440,
    );
    expect(slot).toMatchObject({ state: 'drafted', campaignId });
  });

  it('saves a clean schedule and the sender, and refuses a bad one', async () => {
    const saved = await updateEventComms(h.store, owner, EVENT, {
      reminderOffsetsMinutes: [180, 4_320, 180],
      sender: 'arwin',
    });
    expect(saved.ok && saved.value).toEqual({
      reminder_offsets_minutes: [4_320, 180],
      sender: 'arwin',
    });
    const bad = await updateEventComms(h.store, owner, EVENT, { reminderOffsetsMinutes: [0] });
    expect(bad.ok).toBe(false);
    const { campaignId } = await draft({ kind: 'invite' });
    const detail = await getCampaign(h.store, org, campaignId);
    expect(detail.ok && detail.value.campaign.from_identity).toBe('arwin');
  });
});

describe('Overview and Today', () => {
  it('builds the checklist and next actions from the event, its guests and its messages', async () => {
    const event = await getEvent(h.store, org, EVENT);
    const sessions = await getEventSessions(h.store, org, EVENT);
    if (!event.ok || !sessions.ok) throw new Error('fixtures');
    const view = await eventOverview(h.store, org, event.value, sessions.value);
    expect(view.counts.pending).toBe(1);
    expect(view.checklist.find((i) => i.key === 'invites')?.done).toBe(false);
    expect(view.actions[0]).toMatchObject({ key: 'pending', urgent: true });
    expect(view.headcounts.map((s) => [s.name, s.going, s.capacity])).toEqual([
      ['Annual Meeting', 1, 80],
      ['Evening Reception', 4, 125],
    ]);
    await draft({ kind: 'invite' });
    const after = await eventOverview(h.store, org, event.value, sessions.value);
    expect(after.checklist.find((i) => i.key === 'invites')?.detail).toMatch(
      /waiting for your review/,
    );
  });

  it('gives Today one line per event that wants something', async () => {
    // A fixed clock, after 14:00 UTC: the demo's registration "yesterday at
    // 14:00 UTC" is within a day of the real clock before then, and would
    // read as a new registration.
    const now = new Date('2026-11-04T20:00:00Z');
    await h.dispose();
    h = await createHarness({ now });
    org = h.auth.organizationId;
    const lines = await todayEventLines(h.store, org, now);
    expect(lines).toEqual([
      {
        eventId: EVENT,
        title: 'Harborview Annual Meeting',
        href: `/events/${EVENT}`,
        parts: [{ text: '1 pending', href: `/events/${EVENT}?tab=guests` }],
      },
    ]);
  });
});
