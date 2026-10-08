import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeDueAlerts,
  listSubscriptions,
  recordDelivery,
  removeSubscription,
  saveSubscription,
  SUBSCRIPTION_SCHEMA,
} from '@/lib/services/push-alerts';
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
