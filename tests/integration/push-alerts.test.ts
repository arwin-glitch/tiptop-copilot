import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@/lib/demo/ids';
import {
  buildOutbox,
  CAMPAIGN_ALERT_WINDOW_MS,
  campaignAlertWindowMs,
  computeCampaignAlerts,
  computeDueAlerts,
  listSubscriptions,
  recordDelivery,
  removeSubscription,
  saveSubscription,
  SUBSCRIPTION_SCHEMA,
} from '@/lib/services/push-alerts';
import {
  finishedCampaignsSince,
  getCampaign,
  type CampaignCounts,
  type FinishedCampaign,
} from '@/lib/services/campaigns';
import type { FollowUpsSnapshot } from '@/lib/services/follow-ups';
import { createHarness, type Harness } from '../helpers/harness';

/** Phone alerts: what is due, each item once, daytime only; subscriptions per device. */

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

const EMPTY: FollowUpsSnapshot = {
  waiting: null,
  meetings: [],
  scheduling: [],
  priorities: null,
  relationships: null,
  lpPipeline: null,
  portfolioHealth: null,
  intros: null,
  weekAhead: null,
  lpUpdateDraft: null,
  emailQueue: null,
  emailJudgedAt: {},
};

// 15:00 UTC = 10:00 in Chicago (daylight time).
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const NIGHT = new Date('2026-10-08T04:00:00Z'); // 23:00 Chicago
const TZ = 'America/Chicago';

const SNAPSHOT: FollowUpsSnapshot = {
  ...EMPTY,
  priorities: {
    run_at: '2026-10-07T11:30:00Z',
    source: 'morning',
    items: [
      {
        title: 'Carta invoice day 30',
        why: 'Unpaid',
        kind: 'money',
        thread_id: '1a0000000000aaaa',
      },
      { title: 'Reply to Olivier', why: 'Coffee today', kind: 'reply' },
      { title: 'Nakama draw', why: 'Pending', kind: 'money' },
    ],
  },
  relationships: {
    run_at: '2026-10-07T13:00:00Z',
    waiting: [
      {
        who: 'Jane LP',
        company: 'Fam Office',
        kind: 'prospective_lp',
        since: '2026-10-01T00:00:00Z',
        days: 6,
      },
      { who: 'Vendor Bob', kind: 'other', since: '2026-10-01T00:00:00Z', days: 9 },
      { who: 'New Founder', kind: 'founder', since: '2026-10-06T00:00:00Z', days: 1 },
    ],
    cold: [],
  },
  portfolioHealth: {
    run_at: '2026-10-07T12:30:00Z',
    companies: [
      { name: 'Boost', flag: 'risk', headline: 'Runway ends before profitability', asks: [] },
      { name: 'Santé', flag: 'ok', asks: [] },
    ],
  },
};

describe('computeDueAlerts', () => {
  it('builds one alert per kind with the right items', () => {
    const alerts = computeDueAlerts(SNAPSHOT, new Set(), NOON_ISH, TZ);
    expect(alerts.map((a) => a.tag)).toEqual(['money', 'top3', 'waiting', 'risk']);
    const money = alerts.find((a) => a.tag === 'money')!;
    expect(money.keys).toEqual(['money:1a0000000000aaaa', 'money:nakama-draw']);
    expect(money.body).toBe('Carta invoice day 30 (+1 more)');
    expect(alerts.find((a) => a.tag === 'top3')?.keys).toEqual(['top3:2026-10-07']);
    // Only LP/founder/portfolio waiting 3+ days.
    expect(alerts.find((a) => a.tag === 'waiting')?.body).toBe('Jane LP (Fam Office), 6 days');
    expect(alerts.find((a) => a.tag === 'risk')?.body).toBe(
      'Boost: Runway ends before profitability',
    );
    for (const a of alerts) expect(a.url.startsWith('/')).toBe(true);
  });

  it('never repeats an item already sent', () => {
    const sent = new Set([
      'money:1a0000000000aaaa',
      'money:nakama-draw',
      'top3:2026-10-07',
      'risk:boost',
    ]);
    const alerts = computeDueAlerts(SNAPSHOT, sent, NOON_ISH, TZ);
    expect(alerts.map((a) => a.tag)).toEqual(['waiting']);
  });

  it('stays quiet at night and skips a stale morning list', () => {
    expect(computeDueAlerts(SNAPSHOT, new Set(), NIGHT, TZ)).toEqual([]);
    const tomorrow = new Date('2026-10-08T15:00:00Z');
    expect(computeDueAlerts(SNAPSHOT, new Set(), tomorrow, TZ).some((a) => a.tag === 'top3')).toBe(
      false,
    );
  });
});

describe('subscriptions', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('accepts only real push services', () => {
    expect(SUBSCRIPTION_SCHEMA.safeParse(SUB).success).toBe(true);
    expect(
      SUBSCRIPTION_SCHEMA.safeParse({ ...SUB, endpoint: 'https://evil.example.com/push' }).success,
    ).toBe(false);
    expect(
      SUBSCRIPTION_SCHEMA.safeParse({ ...SUB, endpoint: 'http://fcm.googleapis.com/x' }).success,
    ).toBe(false);
  });

  it('saves one row per device, keeps keys intact, removes on unsubscribe and when gone', async () => {
    const { store, auth } = harness;
    await saveSubscription(store, auth.organizationId, auth.userId, SUB);
    await saveSubscription(store, auth.organizationId, auth.userId, SUB);
    const subs = await listSubscriptions(store, auth.organizationId);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.keys).toEqual(SUB.keys);

    expect(await removeSubscription(store, auth.organizationId, SUB.endpoint)).toBe(1);
    expect(await listSubscriptions(store, auth.organizationId)).toHaveLength(0);

    await saveSubscription(store, auth.organizationId, auth.userId, SUB);
    const result = await recordDelivery(store, auth.organizationId, ['risk:boost'], [SUB.endpoint]);
    expect(result).toEqual({ recorded: 1, removed: 1 });
  });
});

describe('campaign alerts', () => {
  const COUNTS: CampaignCounts = {
    total: 106,
    pending: 0,
    sent: 104,
    failed: 2,
    unconfirmed: 0,
    skipped: 0,
    opened: 40,
    clicked: 9,
    replied: 3,
    bounced: 0,
    unsubscribed: 0,
  };
  const ago = (ms: number) => new Date(NOON_ISH.getTime() - ms).toISOString();
  const campaign = (over: Partial<FinishedCampaign> = {}): FinishedCampaign => ({
    id: '00000000-0000-4000-8000-00000000c001',
    name: 'Q4 LP update',
    status: 'sent',
    sentAt: ago(30 * 60_000),
    counts: COUNTS,
    ...over,
  });

  it('a campaign that just finished alerts once, with its name and counts', () => {
    const alerts = computeCampaignAlerts([campaign()], new Set(), NOON_ISH, TZ);
    expect(alerts).toEqual([
      {
        keys: ['campaign:00000000-0000-4000-8000-00000000c001'],
        title: 'Campaign sent',
        body: 'Q4 LP update · 104/106 · 2 issues',
        url: '/fund-ii/campaigns/00000000-0000-4000-8000-00000000c001',
        tag: 'campaign',
      },
    ]);
    const clean = computeCampaignAlerts(
      [campaign({ counts: { ...COUNTS, sent: 106, failed: 0 } })],
      new Set(),
      NOON_ISH,
      TZ,
    );
    expect(clean[0]?.body).toBe('Q4 LP update · 106/106 · no issues');
  });

  it('never alerts an old campaign, one already alerted, an unfinished one, or at night', () => {
    const old = campaign({ sentAt: ago(CAMPAIGN_ALERT_WINDOW_MS + 60_000) });
    expect(computeCampaignAlerts([old], new Set(), NOON_ISH, TZ)).toEqual([]);
    const sent = new Set(['campaign:00000000-0000-4000-8000-00000000c001']);
    expect(computeCampaignAlerts([campaign()], sent, NOON_ISH, TZ)).toEqual([]);
    expect(
      computeCampaignAlerts([campaign({ status: 'cancelled' })], new Set(), NOON_ISH, TZ),
    ).toEqual([]);
    expect(computeCampaignAlerts([campaign({ sentAt: null })], new Set(), NOON_ISH, TZ)).toEqual(
      [],
    );
    const night = campaign({ sentAt: new Date(NIGHT.getTime() - 60_000).toISOString() });
    expect(computeCampaignAlerts([night], new Set(), NIGHT, TZ)).toEqual([]);
  });

  it('one that finished at night, when alerts are quiet, alerts the next morning instead', () => {
    // Times in Chicago (daylight time, UTC-5).
    const at = (iso: string) => new Date(iso);
    const evening = campaign({ sentAt: '2026-10-07T00:40:00Z' }); // Oct 6, 7:40pm
    const lateNight = campaign({
      id: '00000000-0000-4000-8000-00000000c003',
      sentAt: '2026-10-07T07:00:00Z', // Oct 7, 2am
    });
    const afternoon = campaign({
      id: '00000000-0000-4000-8000-00000000c004',
      sentAt: '2026-10-06T22:30:00Z', // Oct 6, 5:30pm: its two hours ran out by 7:30pm
    });
    const all = [evening, lateNight, afternoon];
    // 8:05pm, quiet: nothing.
    expect(computeCampaignAlerts(all, new Set(), at('2026-10-07T01:05:00Z'), TZ)).toEqual([]);
    // 8:05am: the evening and night ones, once, as one notification.
    const morning = computeCampaignAlerts(all, new Set(), at('2026-10-07T13:05:00Z'), TZ);
    expect(morning).toHaveLength(1);
    expect(morning[0]?.keys).toEqual([
      'campaign:00000000-0000-4000-8000-00000000c001',
      'campaign:00000000-0000-4000-8000-00000000c003',
    ]);
    // Two daytime hours: the 7:40pm one had 20 minutes before 8pm, so it
    // still counts at 9:35am but not at 9:45am.
    expect(
      computeCampaignAlerts([evening], new Set(), at('2026-10-07T14:35:00Z'), TZ),
    ).toHaveLength(1);
    expect(computeCampaignAlerts([evening], new Set(), at('2026-10-07T14:45:00Z'), TZ)).toEqual([]);
    // The window is the plain two hours outside the morning.
    expect(campaignAlertWindowMs(NOON_ISH, TZ)).toBe(CAMPAIGN_ALERT_WINDOW_MS);
    expect(campaignAlertWindowMs(at('2026-10-07T13:05:00Z'), TZ)).toBe(14 * 60 * 60 * 1000);
  });

  it('several at once are one notification that opens the Campaigns tab', () => {
    const second = campaign({
      id: '00000000-0000-4000-8000-00000000c002',
      name: 'SPV offering',
      sentAt: ago(10 * 60_000),
    });
    const alerts = computeCampaignAlerts([second, campaign()], new Set(), NOON_ISH, TZ);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      title: '2 campaigns sent',
      url: '/fund-ii?tab=campaigns',
      body: 'SPV offering · 104/106 · 2 issues (+1 more)',
    });
    expect(alerts[0]?.keys).toEqual([
      'campaign:00000000-0000-4000-8000-00000000c002',
      'campaign:00000000-0000-4000-8000-00000000c001',
    ]);
  });

  describe('from the store', () => {
    // 16:00 UTC is 11am in Chicago; the demo Q3 update finished 12 days before.
    const NOW = new Date('2026-10-16T16:00:00Z');
    let harness: Harness;
    beforeEach(async () => {
      harness = await createHarness({ now: NOW });
    });
    afterEach(async () => {
      await harness.dispose();
    });

    it('alerts the demo update once, soon after it finished, and never names a recipient', async () => {
      const { store, auth } = harness;
      const org = auth.organizationId;
      const detail = await getCampaign(store, org, DEMO_IDS.campaignQ3Update);
      if (!detail.ok) throw new Error(detail.error.message);
      const finishedAt = Date.parse(detail.value.campaign.sent_at ?? '');
      const soon = new Date(finishedAt + 30 * 60_000);

      // Twelve days on, nothing: turning alerts on never pings old campaigns.
      const today = await finishedCampaignsSince(
        store,
        org,
        new Date(NOW.getTime() - CAMPAIGN_ALERT_WINDOW_MS),
      );
      expect(today.ok && today.value).toEqual([]);

      await saveSubscription(store, org, auth.userId, SUB);
      const first = await buildOutbox(store, soon, 'all');
      const alert = first[0]?.alerts.find((a) => a.tag === 'campaign');
      expect(alert).toEqual({
        keys: [`campaign:${DEMO_IDS.campaignQ3Update}`],
        title: 'Campaign sent',
        // 8 people: 1 bounced.
        body: 'Q3 LP update · 7/8 · 1 issue',
        url: `/fund-ii/campaigns/${DEMO_IDS.campaignQ3Update}`,
        tag: 'campaign',
      });
      const payload = JSON.stringify(alert).toLowerCase();
      for (const r of detail.value.recipients) {
        expect(payload).not.toContain(r.email.toLowerCase());
        if (r.name) expect(payload).not.toContain(r.name.toLowerCase());
      }

      // The every-minute meetings pass never carries it.
      const meetings = await buildOutbox(store, soon, 'meetings');
      expect(meetings[0]?.alerts.some((a) => a.tag === 'campaign')).toBe(false);

      // Delivered once: the ledger keeps it from ever alerting again.
      await recordDelivery(store, org, alert!.keys, []);
      const again = await buildOutbox(store, new Date(finishedAt + 60 * 60_000), 'all');
      expect(again[0]?.alerts.some((a) => a.tag === 'campaign')).toBe(false);
    });
  });
});
