import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetEnvCache } from '@/lib/config/env';
import { listOrganizationMembers } from '@/lib/db/members';
import { DEMO_IDS } from '@/lib/demo/ids';
import { desktopAlertsFor } from '@/lib/services/desktop-alerts';
import { buildOutbox, principalTimeZone, saveSubscription } from '@/lib/services/push-alerts';
import { readTeam } from '@/lib/tasks/principal';
import type { AuditEvent, DailyBrief, UserProfile } from '@/lib/types/domain';
import { POST as dailyJob } from '@/app/api/cron/daily/route';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * Alerts follow the principal (D-071): the member whose mailbox Copilot
 * reads, not the organization's owner role, who may be an assistant in
 * another time zone. On the invented demo team, reshaped so the two differ
 * the way a real team does: the teammate set the organization up and is its
 * only owner, in Singapore; the mailbox person is a plain member, in New
 * York. A second organization, in Lisbon, shares the store, so a member read
 * that crossed organizations would show. Every name and address is fictional.
 */

const ORG = DEMO_IDS.org;
const OWNER = DEMO_IDS.userTeammate;
const MAILBOX_PERSON = DEMO_IDS.user;
const OWNER_ZONE = 'Asia/Singapore';
const PRINCIPAL_ZONE = 'America/New_York';
const OTHER_ZONE = 'Europe/Lisbon';

// 11am in New York (daylight time), 11pm in Singapore.
const NY_MORNING = new Date('2026-10-16T15:00:00Z');
// 11pm in New York, 11am the next day in Singapore.
const NY_NIGHT = new Date('2026-10-17T03:00:00Z');

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/principal-test',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

let harness: Harness;
let otherOrg: string;
let otherUser: string;

async function setZone(userId: string, timezone: string) {
  const profile = (await harness.store.userProfileById(userId)) as UserProfile;
  await harness.store.upsertUserProfile({ ...profile, timezone });
}

beforeEach(async () => {
  harness = await createHarness({ now: NY_MORNING });
  const { store } = harness;
  // The mailbox person is a member, not an owner: the owner role is the teammate's alone.
  const [mine] = (await listOrganizationMembers(store, ORG)).filter(
    (m) => m.user_id === MAILBOX_PERSON,
  );
  await store.update('organization_members', ORG, mine!.id, { role: 'member' });
  await setZone(OWNER, OWNER_ZONE);
  await setZone(MAILBOX_PERSON, PRINCIPAL_ZONE);
  const other = await addSecondOrganization(harness);
  otherOrg = other.organizationId;
  otherUser = other.userId;
  await setZone(otherUser, OTHER_ZONE);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
});

describe('the team, as the alerts read it', () => {
  it('has an owner who is not the mailbox person', async () => {
    const team = await readTeam(harness.store, ORG);
    expect(team.principal).toEqual({ userId: MAILBOX_PERSON, basis: 'mailbox_address' });
    expect(team.members.filter((m) => m.role === 'owner').map((m) => m.userId)).toEqual([OWNER]);
  });
});

describe("the alerts' time zone", () => {
  it("is the mailbox person's, not the owner's", async () => {
    expect(await principalTimeZone(harness.store, ORG)).toBe(PRINCIPAL_ZONE);
  });

  it("falls back to the owner's, then to Central time", async () => {
    await setZone(MAILBOX_PERSON, 'Nowhere/Unknown');
    expect(await principalTimeZone(harness.store, ORG)).toBe(OWNER_ZONE);
    await setZone(OWNER, '');
    expect(await principalTimeZone(harness.store, ORG)).toBe('America/Chicago');
  });

  it("is each organization's own, never a member of another's", async () => {
    // Read across organizations, the first owner in the table (the demo
    // teammate) would have decided both.
    expect(await principalTimeZone(harness.store, otherOrg)).toBe(OTHER_ZONE);
    expect(await principalTimeZone(harness.store, ORG)).toBe(PRINCIPAL_ZONE);
  });
});

describe('quiet hours follow the mailbox person', () => {
  async function campaignAlertAt(now: Date) {
    // The demo Q3 update, as if it had finished half an hour before `now`.
    await harness.store.update('campaigns', ORG, DEMO_IDS.campaignQ3Update, {
      sent_at: new Date(now.getTime() - 30 * 60_000).toISOString(),
    });
    const outbox = await buildOutbox(harness.store, now, 'all');
    expect(outbox.map((entry) => entry.organizationId)).toEqual([ORG]);
    return outbox[0]!.alerts.find((alert) => alert.tag === 'campaign') ?? null;
  }

  it('on the phone: their morning alerts, their night waits', async () => {
    await saveSubscription(harness.store, ORG, MAILBOX_PERSON, SUB);
    // 11am for them, 11pm for the owner.
    expect(await campaignAlertAt(NY_MORNING)).toMatchObject({ title: 'Campaign sent' });
    // 11pm for them, 11am for the owner.
    expect(await campaignAlertAt(NY_NIGHT)).toBeNull();
  });

  it("on a computer, even the owner's: asked every minute in their day, not until 6am in their night", async () => {
    const ownersComputer = {
      organizationId: ORG,
      device: 'c0ffee00c0ffee00c0ffee00c0ffee01',
      userId: OWNER,
      enabledAt: NY_MORNING.toISOString(),
    };
    expect(
      (await desktopAlertsFor(harness.store, ownersComputer, NY_MORNING)).pollAfterSeconds,
    ).toBe(60);
    // 11pm in New York: nothing until 6am there, seven hours.
    expect(await desktopAlertsFor(harness.store, ownersComputer, NY_NIGHT)).toEqual({
      alerts: [],
      pollAfterSeconds: 7 * 3600,
    });
  });
});

describe('member reads', () => {
  it("return only the organization's own members", async () => {
    const ids = async (org: string) =>
      (await listOrganizationMembers(harness.store, org)).map((m) => m.user_id).sort();
    expect(await ids(ORG)).toEqual([MAILBOX_PERSON, OWNER].sort());
    expect(await ids(otherOrg)).toEqual([otherUser]);
    const otherTeam = await readTeam(harness.store, otherOrg);
    expect(otherTeam.members.map((m) => m.userId)).toEqual([otherUser]);
    expect(otherTeam.principal?.userId).toBe(otherUser);
  });

  it('refuse a read with no organization', async () => {
    await expect(listOrganizationMembers(harness.store, '')).rejects.toThrow(/no organization/);
  });
});

describe('the daily job', () => {
  const SECRET = 'cron-secret-for-tests-000000000000';
  const SAVED = { ...process.env };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    resetEnvCache();
    // Nothing reaches the network: every relay read finds nothing.
    vi.stubGlobal(
      'fetch',
      (async () => new Response(JSON.stringify({ ok: true, messages: [] }))) as typeof fetch,
    );
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in SAVED)) delete process.env[key];
    }
    Object.assign(process.env, SAVED);
    resetEnvCache();
  });

  it("makes the mailbox person's outlook, and syncs as the owner, each organization with its own", async () => {
    const response = await dailyJob(
      new NextRequest('https://copilot.example/api/cron/daily', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
    const { store } = harness;

    const briefs = (await store.list('daily_briefs', ORG, {})) as DailyBrief[];
    expect(briefs.map((b) => b.user_id)).toEqual([MAILBOX_PERSON]);
    const otherBriefs = (await store.list('daily_briefs', otherOrg, {})) as DailyBrief[];
    expect(otherBriefs.every((b) => b.user_id === otherUser)).toBe(true);

    const synced = (await store.list('audit_events', ORG, {
      eq: { action: 'integration.sync_started' },
    })) as AuditEvent[];
    expect(synced.length).toBeGreaterThan(0);
    expect(synced.every((row) => row.user_id === OWNER)).toBe(true);
  });
});
