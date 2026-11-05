import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS, demoSpaceId } from '@/lib/demo/ids';
import { askSpace, resetSpaceAskCache } from '@/lib/services/space-ask';
import {
  actionSuggestions,
  itemOwner,
  resetSpaceContentCache,
  spaceCards,
  spaceEmailPage,
  spaceItems,
  spaceMemberEmail,
} from '@/lib/services/space-content';
import {
  disconnectMemberConnection,
  listMemberConnections,
  memberItemId,
  myMemberConnection,
  resetMemberMailCache,
  saveMemberConnection,
} from '@/lib/services/space-member-mail';
import { isMemberReadOnlyGrant } from '@/lib/google/oauth';
import {
  answerInvite,
  getSpaceAccess,
  removeMember,
  setItemHidden,
  spaceContributors,
  type SpaceViewer,
} from '@/lib/services/spaces';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { resetInboxLiveCache } from '@/lib/services/inbox-live';
import { searchEverything } from '@/lib/services/search';
import { linkMailbox } from '@/lib/services/task-close';
import { readTeam } from '@/lib/tasks/principal';

/**
 * A member's own Google for Spaces (D-081), end to end on the demo store:
 * the demo teammate (fictional) has a read-only connection with a fictional
 * mailbox. Their mail shows only in the Space they accepted (Stonebridge
 * Ops), only what matches its rules, minus hidden items; never in Ledgerly
 * (only invited), never anywhere else; and leaving or disconnecting stops it
 * at once. Nothing reaches Google.
 */

let harness: Harness;
const LEDGERLY = demoSpaceId('space', 0);
const STONEBRIDGE = demoSpaceId('space', 1);
const TEAMMATE = DEMO_IDS.userTeammate;
const SHORTLIST = 'a1b2c3d4e5f60001';
const LEDGERLY_PANEL = 'a1b2c3d4e5f60003';
const DENTIST = 'a1b2c3d4e5f60004';

const owner = (): SpaceViewer => ({
  organizationId: DEMO_IDS.org,
  userId: DEMO_IDS.user,
  role: 'owner',
  isDemo: true,
});
const teammate = (): SpaceViewer => ({
  organizationId: DEMO_IDS.org,
  userId: TEAMMATE,
  role: 'member',
  isDemo: true,
});

beforeEach(async () => {
  harness = await createHarness();
  resetSpaceContentCache();
  resetSpaceAskCache();
  resetInboxLiveCache();
  resetMemberMailCache();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

async function access(space: string, viewer = owner()) {
  const a = await getSpaceAccess(harness.store, viewer, space);
  if (!a.ok) throw new Error(a.error.message);
  return a.value;
}

describe('what a contributor brings in', () => {
  it('shows their matching mail and meetings in the Space they accepted, labelled theirs', async () => {
    const items = await spaceItems(harness.store, await access(STONEBRIDGE));
    const theirs = items.threads.filter((t) => t.member);
    expect(theirs.map((t) => t.member?.threadId).sort()).toEqual([SHORTLIST, 'a1b2c3d4e5f60002']);
    expect(theirs.every((t) => t.owner === TEAMMATE)).toBe(true);
    expect(theirs.every((t) => t.member?.mailbox === 'riley@fund.demo')).toBe(true);
    expect(theirs[0]!.id).toBe(memberItemId(TEAMMATE, theirs[0]!.member!.threadId));
    // The main mailbox's Stonebridge thread is there too.
    expect(items.threads.some((t) => !t.member)).toBe(true);
    const meetings = items.meetings.filter((m) => m.fromMember).map((m) => m.title);
    expect(meetings.sort()).toEqual([
      'Stonebridge hiring sync',
      'Stonebridge warehouse pilot review',
    ]);
    // Nothing outside the rules: the dentist and the gym never come in.
    expect(JSON.stringify(items)).not.toMatch(/Dentist|Gym/);
  });

  it('counts contributors on the card and the Emails tab merges every mailbox', async () => {
    const cards = await spaceCards(harness.store, owner());
    const card = cards.ok ? cards.value.find((c) => c.id === STONEBRIDGE) : undefined;
    const items = await spaceItems(harness.store, await access(STONEBRIDGE));
    expect(card?.counts?.emails).toBe(items.threads.length);
    expect(card?.counts?.emails).toBeGreaterThanOrEqual(3);

    const page = await spaceEmailPage(harness.store, await access(STONEBRIDGE));
    expect(page.mailbox).toBe('all');
    expect(page.mailboxes.map((m) => m.key)).toEqual(['all', 'primary', TEAMMATE]);
    const member = page.rows.filter((r) => !r.primary);
    expect(member.map((r) => r.threadId).sort()).toEqual([SHORTLIST, 'a1b2c3d4e5f60002']);
    expect(member.every((r) => r.mailbox === 'riley@fund.demo' && r.owner === TEAMMATE)).toBe(true);
    const alone = await spaceEmailPage(harness.store, await access(STONEBRIDGE), {
      mailbox: TEAMMATE,
    });
    expect(alone.rows.every((r) => !r.primary)).toBe(true);
  });

  it('never brings in a Space they are only invited to', async () => {
    const before = await spaceItems(harness.store, await access(LEDGERLY));
    expect(before.threads.some((t) => t.member)).toBe(false);
    expect(before.meetings.some((m) => m.fromMember)).toBe(false);
    const page = await spaceEmailPage(harness.store, await access(LEDGERLY));
    expect(page.rows.every((r) => r.primary)).toBe(true);
    expect(page.mailboxes.map((m) => m.key)).toEqual(['primary']);
    // Accepting brings their matching Ledgerly mail in, and only that.
    await answerInvite(harness.store, teammate(), LEDGERLY, 'accept');
    const after = await spaceItems(harness.store, await access(LEDGERLY));
    expect(after.threads.filter((t) => t.member).map((t) => t.member!.threadId)).toEqual([
      LEDGERLY_PANEL,
    ]);
    expect(after.meetings.filter((m) => m.fromMember).map((m) => m.title)).toEqual([
      'Ledgerly VP Sales panel',
    ]);
  });

  it('stops at once when they leave, and after a decline', async () => {
    const a = await access(STONEBRIDGE);
    expect((await spaceItems(harness.store, a)).threads.some((t) => t.member)).toBe(true);
    const cardsBefore = await spaceCards(harness.store, owner());
    const left = await removeMember(harness.store, teammate(), STONEBRIDGE, TEAMMATE);
    expect(left.ok).toBe(true);
    const after = await spaceItems(harness.store, await access(STONEBRIDGE));
    expect(after.threads.some((t) => t.member)).toBe(false);
    expect(after.meetings.some((m) => m.fromMember)).toBe(false);
    const cardsAfter = await spaceCards(harness.store, owner());
    const count = (c: typeof cardsBefore) =>
      c.ok ? c.value.find((x) => x.id === STONEBRIDGE)?.counts?.emails : -1;
    expect(count(cardsAfter)).toBe((count(cardsBefore) ?? 0) - 2);
    const askAfter = await askSpace(
      harness.store,
      harness.auth,
      await access(STONEBRIDGE),
      'engineer shortlist',
      { summary: true },
    );
    expect(askAfter.ok && askAfter.value.sources.some((s) => s.id.startsWith('m.'))).toBe(false);
  });

  it('stops at once when they disconnect: revoked, tokens and row deleted', async () => {
    const cardsBefore = await spaceCards(harness.store, owner());
    const done = await disconnectMemberConnection(harness.store, teammate());
    expect(done.ok && done.value.wasConnected).toBe(true);
    const rows = await listMemberConnections(harness.store, DEMO_IDS.org);
    expect(rows.rows).toEqual([]);
    const all = await harness.store.list('integrations', DEMO_IDS.org, {});
    expect(all.map((i) => i.provider)).toEqual(['google']);
    const items = await spaceItems(harness.store, await access(STONEBRIDGE));
    expect(items.threads.some((t) => t.member)).toBe(false);
    const cardsAfter = await spaceCards(harness.store, owner());
    const count = (c: typeof cardsBefore) =>
      c.ok ? c.value.find((x) => x.id === STONEBRIDGE)?.counts?.emails : -1;
    expect(count(cardsAfter)).toBe((count(cardsBefore) ?? 0) - 2);
    const who = await spaceContributors(harness.store, await access(STONEBRIDGE));
    expect(who.withoutMailbox).toContain(TEAMMATE);
    // The primary is untouched.
    const primary = await getPrimaryIntegration(harness.store, DEMO_IDS.org);
    expect(primary?.id).toBe(DEMO_IDS.integrationGoogle);
    expect(primary?.status).toBe('connected');
  });
});

describe('hiding and opening a contributor item', () => {
  it('lets its owner hide it, for everyone, and not someone else’s', async () => {
    const mine = await access(STONEBRIDGE, teammate());
    const id = memberItemId(TEAMMATE, SHORTLIST);
    expect(await itemOwner(harness.store, mine, 'email', id)).toBe(TEAMMATE);
    const hid = await setItemHidden(
      harness.store,
      teammate(),
      mine,
      { kind: 'email', id, owner: TEAMMATE },
      true,
    );
    expect(hid.ok).toBe(true);
    const after = await spaceItems(harness.store, await access(STONEBRIDGE));
    expect(after.threads.some((t) => t.id === id)).toBe(false);
    const viewer = await spaceMemberEmail(harness.store, await access(STONEBRIDGE), id);
    expect(!viewer.ok && viewer.error.code).toBe('not_found');
    // The main mailbox's items are not theirs to hide.
    const primaryThread = after.threads.find((t) => !t.member)!;
    const owned = await itemOwner(harness.store, mine, 'email', primaryThread.id);
    const refused = await setItemHidden(
      harness.store,
      teammate(),
      mine,
      { kind: 'email', id: primaryThread.id, owner: owned },
      true,
    );
    expect(!refused.ok && refused.error.code).toBe('forbidden');
  });

  it('opens it read-only in the Space, and nothing outside the rules', async () => {
    const a = await access(STONEBRIDGE);
    const open = await spaceMemberEmail(harness.store, a, memberItemId(TEAMMATE, SHORTLIST));
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.value.mailbox).toBe('riley@fund.demo');
      expect(open.value.messages.length).toBe(2);
    }
    for (const raw of [LEDGERLY_PANEL, DENTIST, 'ffffffffffffffff']) {
      const res = await spaceMemberEmail(harness.store, a, memberItemId(TEAMMATE, raw));
      expect(!res.ok && res.error.code, raw).toBe('not_found');
    }
    // Ledgerly: invited only, so not even their Ledgerly thread opens there.
    const ledgerly = await spaceMemberEmail(
      harness.store,
      await access(LEDGERLY),
      memberItemId(TEAMMATE, LEDGERLY_PANEL),
    );
    expect(!ledgerly.ok && ledgerly.error.code).toBe('not_found');
  });
});

describe('the boundary, behaviourally', () => {
  it('never stands in for the main mailbox, though it is the newer row', async () => {
    const primary = await getPrimaryIntegration(harness.store, DEMO_IDS.org);
    expect(primary?.provider).toBe('google');
    expect(primary?.account_email).toBe('nick@tiptop.demo');
    expect(await linkMailbox(harness.store, DEMO_IDS.org)).toBe('nick@tiptop.demo');
    const team = await readTeam(harness.store, DEMO_IDS.org);
    expect(team.principal?.userId).toBe(DEMO_IDS.user);
  });

  it('keeps their mail out of search and out of action suggestions', async () => {
    for (const q of ['engineer shortlist', 'logistics advisor', 'Dentist']) {
      const results = await searchEverything(harness.store, DEMO_IDS.org, q, harness.auth);
      expect(JSON.stringify(results), q).not.toMatch(/shortlist for Thursday|logistics advisor/);
    }
    const suggestions = await actionSuggestions(harness.store, await access(STONEBRIDGE));
    expect(suggestions.some((s) => s.from.includes('m.'))).toBe(false);
  });

  it('shows each person only their own connection', async () => {
    const mine = await myMemberConnection(harness.store, teammate());
    expect(mine.connection?.email).toBe('riley@fund.demo');
    expect(mine.connection?.status).toBe('connected');
    expect(JSON.stringify(mine)).not.toMatch(/token|scope/i);
    const nick = await myMemberConnection(harness.store, owner());
    expect(nick.connection).toBeNull();
    expect(nick.isMainMailbox).toBe(true);
  });
});

describe('connecting', () => {
  it('asks Google for the read-only scopes alone', async () => {
    process.env.GOOGLE_CLIENT_ID ||= 'test-client';
    process.env.GOOGLE_CLIENT_SECRET ||= 'test-secret';
    const { resetEnvCache } = await import('@/lib/config/env');
    resetEnvCache();
    const { buildAuthorizationUrl } = await import('@/lib/google/oauth');
    const url = buildAuthorizationUrl('state', { member: true, send: true } as never);
    expect(url.ok).toBe(true);
    if (!url.ok) return;
    const params = new URL(url.value).searchParams;
    expect(params.get('scope')!.split(' ')).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    expect(params.get('include_granted_scopes')).toBe('false');
    expect(params.get('access_type')).toBe('offline');
  });

  it('refuses a grant with any write scope, and the main mailbox’s own account', async () => {
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 3600 };
    expect(
      isMemberReadOnlyGrant([
        'openid',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
      ]),
    ).toBe(false);
    const write = await saveMemberConnection(harness.store, {
      organizationId: DEMO_IDS.org,
      userId: TEAMMATE,
      accountEmail: 'riley@fund.demo',
      grantedScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      tokens,
    });
    expect(!write.ok && write.error.code).toBe('invalid_input');
    const main = await saveMemberConnection(harness.store, {
      organizationId: DEMO_IDS.org,
      userId: TEAMMATE,
      accountEmail: 'Nick@tiptop.demo',
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      tokens,
    });
    expect(!main.ok && main.error.code).toBe('invalid_input');
  });

  it('stores a read-only grant as the member’s own row, beside the primary', async () => {
    await disconnectMemberConnection(harness.store, teammate());
    const saved = await saveMemberConnection(harness.store, {
      organizationId: DEMO_IDS.org,
      userId: TEAMMATE,
      accountEmail: 'riley@fund.demo',
      grantedScopes: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
      ],
      tokens: { accessToken: 'access-x', refreshToken: 'refresh-x', expiresInSeconds: 3600 },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.provider).toBe('google_space');
    expect(saved.value.user_id).toBe(TEAMMATE);
    expect(saved.value.scopes).not.toContain('https://www.googleapis.com/auth/gmail.modify');
    const tokens = await harness.store.list('encrypted_provider_tokens', DEMO_IDS.org, {
      eq: { integration_id: saved.value.id },
    });
    expect(tokens.length).toBe(2);
    // Sealed: the plaintext is not in the stored row.
    expect(JSON.stringify(tokens)).not.toMatch(/refresh-x|access-x/);
    const primary = await getPrimaryIntegration(harness.store, DEMO_IDS.org);
    expect(primary?.id).toBe(DEMO_IDS.integrationGoogle);
  });
});
