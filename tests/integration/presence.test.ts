import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VISIT_ACTION,
  mailboxOwnerPresence,
  recordVisit,
  resetPresenceCache,
} from '@/lib/services/presence';
import { newId } from '@/lib/util/hash';
import { createHarness, type Harness } from '../helpers/harness';

/** "Nick last opened the app" on Follow-ups, for Arwin. */

let harness: Harness;
const ARWIN = '00000000-0000-4000-8000-00000000a1a1';

beforeEach(async () => {
  resetPresenceCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function addArwin() {
  const { store, auth } = harness;
  const now = new Date().toISOString();
  await store.upsertUserProfile({
    id: ARWIN,
    email: 'arwin@tiptop.demo',
    full_name: 'Arwin Reyes',
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: now,
    updated_at: now,
  });
  await store.insert('organization_members', {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: ARWIN,
    role: 'member',
    created_at: now,
  });
}

describe('presence', () => {
  it('records a visit at most once per 15 minutes', async () => {
    const { store, auth } = harness;
    const t0 = new Date('2026-10-12T15:00:00Z');
    expect(await recordVisit(store, auth.organizationId, auth.userId, t0)).toBe(true);
    expect(
      await recordVisit(store, auth.organizationId, auth.userId, new Date(t0.getTime() + 60_000)),
    ).toBe(false);
    expect(
      await recordVisit(
        store,
        auth.organizationId,
        auth.userId,
        new Date(t0.getTime() + 16 * 60_000),
      ),
    ).toBe(true);
    const visits = await store.count('audit_events', auth.organizationId, {
      eq: { action: VISIT_ACTION, user_id: auth.userId },
    });
    expect(visits).toBe(2);
  });

  it("shows the mailbox owner's last visit to someone else, never to the owner", async () => {
    const { store, auth } = harness;
    await addArwin();
    const owner = await store.userProfileById(auth.userId);
    const mailbox = owner!.email;
    const t = new Date(Date.now() + 60_000);
    await recordVisit(store, auth.organizationId, auth.userId, t);

    const seen = await mailboxOwnerPresence(store, auth.organizationId, ARWIN, mailbox);
    expect(seen?.signedIn).toBe(true);
    expect(seen?.lastSeenAt).toBe(t.toISOString());
    expect(seen?.alertDevices).toBe(0);

    expect(await mailboxOwnerPresence(store, auth.organizationId, auth.userId, mailbox)).toBeNull();
  });

  it('says so when the mailbox owner has never signed in', async () => {
    const { store, auth } = harness;
    const seen = await mailboxOwnerPresence(
      store,
      auth.organizationId,
      auth.userId,
      'nick@elsewhere.test',
    );
    expect(seen).toEqual({ name: 'Nick', signedIn: false, lastSeenAt: null, alertDevices: 0 });
  });
});
