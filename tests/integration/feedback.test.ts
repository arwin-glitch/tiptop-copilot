import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import {
  authenticateDesktopToken,
  desktopAlertsFor,
  recordDesktopDelivery,
  registerDesktopDevice,
  type DesktopAlert,
  type DesktopCaller,
} from '@/lib/services/desktop-alerts';
import {
  FEEDBACK_NOTE_ACTION,
  feedbackAlertsOn,
  listFeedback,
  recordFeedback,
  setFeedbackAlerts,
  setFeedbackStatus,
} from '@/lib/services/feedback';
import type { AuditEvent, UserProfile } from '@/lib/types/domain';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * In-app feedback on the demo store (D-060): notes kept exactly as sent with
 * their page, newest first, closed and reopened by appending, kept to their
 * own organization, and the opt-in desktop alert that reaches only the
 * computers of whoever turned it on, never the sender's. All names, ids and
 * notes are invented.
 */

// 15:00 UTC = 10:00 in Chicago (daylight time), the demo owner's timezone.
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const NIGHT = new Date('2026-10-08T04:00:00Z'); // 23:00 Chicago
const MIN = 60_000;
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

const SENDER_DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const READER_DEVICE = '0123456789abcdef0123456789abcdef';

let harness: Harness;
let store: DataStore;
let auth: AuthContext;

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  store = harness.store;
  auth = harness.auth;
});

afterEach(async () => {
  await harness.dispose();
});

const sender = () => ({ id: auth.userId, name: 'Avery' });

/** A colleague in the demo organization: the one who reads the feedback. */
async function colleague(): Promise<AuthContext> {
  const userId = '00000000-0000-4000-8000-0000000c0b01';
  const at = NOON_ISH.toISOString();
  const profile: UserProfile = {
    id: userId,
    email: 'member1@fund.example',
    full_name: 'Robin Example',
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: at,
    updated_at: at,
  };
  await store.upsertUserProfile(profile);
  await store.insert('organization_members', {
    id: 'member-member-1',
    organization_id: auth.organizationId,
    user_id: userId,
    role: 'member',
    created_at: at,
  });
  return { ...auth, userId, role: 'member', profile };
}

async function turnOn(who: AuthContext, device: string): Promise<DesktopCaller> {
  const result = await registerDesktopDevice(
    store,
    who,
    { device, platform: 'windows', version: '0.4.1' },
    after(NOON_ISH, -60 * MIN),
  );
  if (!result.ok) throw new Error(result.error.message);
  const caller = await authenticateDesktopToken(store, result.value.token);
  if (!caller.ok) throw new Error(caller.error.message);
  return caller.value;
}

const feedbackOnly = (alerts: DesktopAlert[]) =>
  alerts.filter((a) => a.keys.some((k) => k.startsWith('feedback:')));

describe('sending and reading feedback', () => {
  it('keeps the words as sent, with the page, newest first and open', async () => {
    const first = await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: '  Put the stage first on deal cards.  ', path: '/deals', title: 'Deals' },
      NOON_ISH,
    );
    const second = await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: 'The calendar should start on Monday.', path: '/calendar?view=week', title: null },
      after(NOON_ISH, MIN),
    );
    expect(first.ok && second.ok).toBe(true);

    const list = await listFeedback(store, auth.organizationId);
    expect(list.map((n) => n.text)).toEqual([
      'The calendar should start on Monday.',
      'Put the stage first on deal cards.',
    ]);
    expect(list[1]).toMatchObject({
      path: '/deals',
      title: 'Deals',
      by: 'Avery',
      userId: auth.userId,
      status: 'open',
      changedAt: null,
    });
    expect(list[0]?.path).toBe('/calendar?view=week');

    // One row per note, written directly: not redacted, not an audit summary.
    const rows = (await store.list('audit_events', auth.organizationId, {
      eq: { action: FEEDBACK_NOTE_ACTION },
    })) as AuditEvent[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entity_type === 'feedback' && r.entity_id === r.id)).toBe(true);
  });

  it('keeps a page that is not plainly in-app as no page, and refuses an empty or long note', async () => {
    const odd = await recordFeedback(store, auth.organizationId, sender(), {
      text: 'Something about this page.',
      path: '//elsewhere.example/x',
    });
    expect(odd.ok && odd.value.path).toBeNull();

    const empty = await recordFeedback(store, auth.organizationId, sender(), { text: '   ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toBe('Write what to change first.');

    const long = await recordFeedback(store, auth.organizationId, sender(), {
      text: 'x'.repeat(2001),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.message).toBe('Feedback is at most 2,000 characters.');

    const wrong = await recordFeedback(store, auth.organizationId, sender(), {
      text: 42 as unknown as string,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.message).toBe('That feedback is not valid.');
  });

  it('marks a note done and open again by appending, the newest winning', async () => {
    const sent = await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: 'Bigger buttons on the phone.' },
      NOON_ISH,
    );
    if (!sent.ok) throw new Error(sent.error.message);
    const reader = { id: auth.userId, name: 'Robin' };

    const done = await setFeedbackStatus(
      store,
      auth.organizationId,
      reader,
      { id: sent.value.id, status: 'done' },
      after(NOON_ISH, MIN),
    );
    expect(done.ok).toBe(true);
    let [item] = await listFeedback(store, auth.organizationId);
    expect(item).toMatchObject({ status: 'done', changedBy: 'Robin' });

    await setFeedbackStatus(
      store,
      auth.organizationId,
      reader,
      { id: sent.value.id, status: 'open' },
      after(NOON_ISH, 2 * MIN),
    );
    [item] = await listFeedback(store, auth.organizationId);
    expect(item?.status).toBe('open');
  });

  it('closes only a note that exists, and only a real id', async () => {
    const missing = await setFeedbackStatus(store, auth.organizationId, sender(), {
      id: '00000000-0000-4000-8000-00000000dead',
      status: 'done',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not_found');

    const bad = await setFeedbackStatus(store, auth.organizationId, sender(), {
      id: '../etc',
      status: 'done',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid_input');
  });

  it('keeps each organization to its own notes', async () => {
    const sent = await recordFeedback(store, auth.organizationId, sender(), {
      text: 'Only for this fund.',
    });
    if (!sent.ok) throw new Error(sent.error.message);
    const other = await addSecondOrganization(harness);

    expect(await listFeedback(store, other.organizationId)).toEqual([]);
    const closed = await setFeedbackStatus(store, other.organizationId, sender(), {
      id: sent.value.id,
      status: 'done',
    });
    expect(closed.ok).toBe(false);
    const [mine] = await listFeedback(store, auth.organizationId);
    expect(mine?.status).toBe('open');
  });
});

describe('desktop alerts for new feedback', () => {
  it('is off until a person turns it on, and the newest choice wins', async () => {
    expect(await feedbackAlertsOn(store, auth.organizationId, auth.userId)).toBe(false);
    await setFeedbackAlerts(store, auth.organizationId, auth.userId, true, NOON_ISH);
    expect(await feedbackAlertsOn(store, auth.organizationId, auth.userId)).toBe(true);
    await setFeedbackAlerts(store, auth.organizationId, auth.userId, false, after(NOON_ISH, MIN));
    expect(await feedbackAlertsOn(store, auth.organizationId, auth.userId)).toBe(false);
  });

  it("pings the reader's computer once, never the sender's, and only when asked for", async () => {
    const reader = await colleague();
    const readerComputer = await turnOn(reader, READER_DEVICE);
    const senderComputer = await turnOn(auth, SENDER_DEVICE);
    // Both asked for feedback alerts: the sender still never hears of their own note.
    await setFeedbackAlerts(store, auth.organizationId, auth.userId, true, NOON_ISH);

    await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: 'Show who opened each link.', path: '/fund-ii', title: 'Fund II' },
      NOON_ISH,
    );
    const at = after(NOON_ISH, MIN);

    // The reader has not turned feedback alerts on yet: nothing.
    expect(feedbackOnly((await desktopAlertsFor(store, readerComputer, at)).alerts)).toEqual([]);

    await setFeedbackAlerts(store, reader.organizationId, reader.userId, true, NOON_ISH);
    const [alert] = feedbackOnly((await desktopAlertsFor(store, readerComputer, at)).alerts);
    expect(alert).toMatchObject({
      title: 'New feedback',
      body: 'Avery: Show who opened each link.',
      url: '/ask?tab=feedback',
      urgent: false,
      quietWhenFocused: false,
    });
    expect(feedbackOnly((await desktopAlertsFor(store, senderComputer, at)).alerts)).toEqual([]);

    // Shown once: the computer's ledger takes the key, and it does not come back.
    const recorded = await recordDesktopDelivery(
      store,
      readerComputer.organizationId,
      readerComputer.device,
      alert?.keys ?? [],
      at,
    );
    expect(recorded.recorded).toBe(1);
    expect(
      feedbackOnly((await desktopAlertsFor(store, readerComputer, after(at, MIN))).alerts),
    ).toEqual([]);
  });

  it('waits for the morning, and forgets a note once it is done', async () => {
    const reader = await colleague();
    const readerComputer = await turnOn(reader, READER_DEVICE);
    await setFeedbackAlerts(store, reader.organizationId, reader.userId, true, NOON_ISH);

    const night = await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: 'Late thought: darker gold.' },
      after(NIGHT, -MIN),
    );
    if (!night.ok) throw new Error(night.error.message);
    const kept = await recordFeedback(
      store,
      auth.organizationId,
      sender(),
      { text: 'Also: bigger dates on the cards.' },
      after(NIGHT, -MIN),
    );
    if (!kept.ok) throw new Error(kept.error.message);
    expect(feedbackOnly((await desktopAlertsFor(store, readerComputer, NIGHT)).alerts)).toEqual([]);

    await setFeedbackStatus(
      store,
      auth.organizationId,
      { id: reader.userId, name: 'Robin' },
      { id: night.value.id, status: 'done' },
      NIGHT,
    );
    // In the morning the note still open pings; the one marked done does not.
    const morning = new Date('2026-10-08T12:30:00Z'); // 07:30 Chicago
    const [alert, ...rest] = feedbackOnly(
      (await desktopAlertsFor(store, readerComputer, morning)).alerts,
    );
    expect(rest).toEqual([]);
    expect(alert?.keys).toEqual([`feedback:${kept.value.id}`]);
    expect(alert?.body).toBe('Avery: Also: bigger dates on the cards.');
  });
});
