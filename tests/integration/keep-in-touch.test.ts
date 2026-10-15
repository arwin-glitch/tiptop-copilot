import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import { getRecord } from '@/lib/services/crm';
import {
  CADENCE_ACTION,
  keepInTouchFor,
  listKeepInTouch,
  readCadences,
  setCadence,
  sweepKeepInTouch,
} from '@/lib/services/keep-in-touch';
import { getRecordRelationship, resetRelationshipCache } from '@/lib/services/relationships';
import type { CrmRecord, EmailMessage, Task } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';

/**
 * Keep-in-touch cadences and their check-in tasks against the demo store and
 * its invented CRM records. Evidence is mail inserted here, at fixed dates
 * relative to a fixed "now"; every name and address is fictional.
 */

const NOW = new Date('2026-10-15T15:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);
const later = (days: number) => new Date(NOW.getTime() + days * DAY);

const MARROWGATE = demoCrmId('record', 9); // Marrowgate Software, marrowgate.example
const FELIX = demoCrmId('record', 19); // Felix Garroway, felix@marrowgate.example
const OWEN = demoCrmId('record', 23); // Owen Thistlewood, owen@thistlewood.example

const actor = { userId: DEMO_IDS.user, name: 'Morgan Ellery' };

let harness: Harness;
let store: DataStore;
let org: string;

beforeEach(async () => {
  // Evidence comes from the cached relationship index; every test has its own store.
  resetRelationshipCache();
  harness = await createHarness({ now: NOW });
  store = harness.store;
  org = harness.auth.organizationId;
});

afterEach(async () => {
  resetRelationshipCache();
  await harness.dispose();
});

/** An email from the fund to `to`, `daysAgo` before NOW. */
async function mailTo(to: string, daysAgo: number) {
  await mail('nick@tiptop.demo', [to], daysAgo);
}

/** An email from `from` to `to`, `daysAgo` before NOW. */
async function mail(from: string, to: string[], daysAgo: number) {
  const [template] = (await store.list('email_messages', org, {}, { limit: 1 })) as EmailMessage[];
  if (!template) throw new Error('no demo message to copy');
  const sent = ago(daysAgo).toISOString();
  await store.insert('email_messages', {
    ...template,
    id: newId(),
    thread_id: `kit-thread-${newId()}`,
    provider_message_id: `kit-${newId()}`,
    from_name: null,
    from_address: from,
    to_addresses: to,
    cc_addresses: [],
    sent_at: sent,
    created_at: sent,
    updated_at: sent,
  });
}

/** An invented second member of the fund, to set cadences as. */
async function addMember(): Promise<{ userId: string; name: string }> {
  const userId = '44444444-4444-4444-8444-444444444444';
  await harness.store.upsertUserProfile({
    id: userId,
    email: 'ines.calloway@tiptop.demo',
    full_name: 'Ines Calloway',
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  await store.insert('organization_members', {
    id: 'member-ines',
    organization_id: org,
    user_id: userId,
    role: 'member',
    created_at: NOW.toISOString(),
  });
  return { userId, name: 'Ines Calloway' };
}

async function checkIns(): Promise<Task[]> {
  const tasks = (await store.list('tasks', org, {})) as Task[];
  return tasks.filter((t) => t.title.startsWith('Check in with'));
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('setting a cadence', () => {
  it('keeps every setting as a row, newest winning, and turning it off is a row too', async () => {
    value(await setCadence(store, org, OWEN, { choice: 'monthly' }, actor, ago(3)));
    value(await setCadence(store, org, OWEN, { choice: 'custom', customDays: 10 }, actor, ago(2)));
    expect((await readCadences(store, org)).get(OWEN)).toMatchObject({
      days: 10,
      choice: 'custom',
      setBy: 'Morgan Ellery',
    });
    value(await setCadence(store, org, OWEN, { choice: 'off' }, actor, ago(1)));
    expect((await readCadences(store, org, [OWEN])).get(OWEN)).toBeNull();
    const rows = await store.list('audit_events', org, { eq: { action: CADENCE_ACTION } });
    expect(rows).toHaveLength(3);
    expect(value(await listKeepInTouch(store, org, NOW))).toEqual([]);
  });

  it('refuses a custom number out of range and a record that does not exist', async () => {
    const bad = await setCadence(store, org, OWEN, { choice: 'custom', customDays: 0 }, actor);
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
    const missing = await setCadence(
      store,
      org,
      '00000000-0000-4000-8000-000000000000',
      { choice: 'monthly' },
      actor,
    );
    expect(!missing.ok && missing.error.code).toBe('not_found');
    const garbage = await setCadence(store, org, 'not-a-record', { choice: 'monthly' }, actor);
    expect(!garbage.ok && garbage.error.code).toBe('not_found');
  });

  it('with no contact on record, counts from when it was set and adds no task', async () => {
    const result = value(await setCadence(store, org, OWEN, { choice: 'monthly' }, actor, NOW));
    expect(result.created).toEqual([]);
    const owen = (await store.get('crm_records', org, OWEN)) as CrmRecord;
    const profile = value(await keepInTouchFor(store, org, owen, NOW));
    expect(profile.status).toMatchObject({ basis: 'set', state: 'on_track', daysUntilDue: 30 });
    expect(profile.evidence.lastContactAt).toBeNull();
    expect(await checkIns()).toEqual([]);
  });
});

describe('check-in tasks', () => {
  it('adds one at once for a record already due, linked to its profile, and only once', async () => {
    await mailTo('felix@marrowgate.example', 45);
    const result = value(await setCadence(store, org, FELIX, { choice: 'monthly' }, actor, NOW));
    expect(result.created).toEqual(['Check in with Felix Garroway']);

    const [task, ...rest] = await checkIns();
    expect(rest).toEqual([]);
    expect(task).toMatchObject({
      status: 'open',
      source: 'suggested',
      assigned_to: DEMO_IDS.user,
      due_at: ago(15).toISOString(),
    });
    expect(task?.detail).toContain('Keep in touch: every month.');
    expect(task?.detail).toContain('Last contact: an email to them on');
    expect(task?.detail).toContain(`/lists/records/${FELIX}`);

    const again = await sweepKeepInTouch(store, org, { now: NOW });
    expect(again).toEqual({ created: [], existing: ['Check in with Felix Garroway'] });
    expect(await checkIns()).toHaveLength(1);
  });

  it('never brings back a finished one, and adds the next round a cadence later', async () => {
    await mailTo('felix@marrowgate.example', 45);
    value(await setCadence(store, org, FELIX, { choice: 'monthly' }, actor, NOW));
    const [task] = await checkIns();
    await store.update('tasks', org, task?.id as string, {
      status: 'complete',
      completed_at: later(1).toISOString(),
    });

    // Finished: the cadence now counts from the check-in, so nothing is due.
    expect((await sweepKeepInTouch(store, org, { now: later(2) })).created).toEqual([]);
    const felix = (await store.get('crm_records', org, FELIX)) as CrmRecord;
    const profile = value(await keepInTouchFor(store, org, felix, later(2)));
    expect(profile.status).toMatchObject({ basis: 'check_in', state: 'on_track' });

    // A cadence after the check-in, the next round's task.
    const next = await sweepKeepInTouch(store, org, { now: later(32) });
    expect(next.created).toEqual(['Check in with Felix Garroway']);
    const all = await checkIns();
    expect(all.map((t) => t.status).sort()).toEqual(['complete', 'open']);
    // ...and only that one.
    expect((await sweepKeepInTouch(store, org, { now: later(33) })).created).toEqual([]);
  });

  it('counts a company as in touch through anyone at its domain', async () => {
    await mailTo('felix@marrowgate.example', 20);
    const result = value(
      await setCadence(store, org, MARROWGATE, { choice: 'biweekly' }, actor, NOW),
    );
    expect(result.created).toEqual(['Check in with Marrowgate Software']);
    const company = (await store.get('crm_records', org, MARROWGATE)) as CrmRecord;
    const profile = value(await keepInTouchFor(store, org, company, NOW));
    expect(profile.evidence.lastContactKind).toBe('outbound');
    expect(profile.status).toMatchObject({ basis: 'contact', state: 'overdue', daysUntilDue: -6 });
  });

  it('gives a task made by the daily job to whoever set the cadence', async () => {
    const ines = await addMember();
    await mailTo('felix@marrowgate.example', 10);
    // Not due yet when set, so nothing is made then.
    value(await setCadence(store, org, FELIX, { choice: 'monthly' }, ines, NOW));
    expect(await checkIns()).toEqual([]);
    // The daily job has no actor; the task still goes to the setter, not the owner.
    resetRelationshipCache();
    expect((await sweepKeepInTouch(store, org, { now: later(25) })).created).toEqual([
      'Check in with Felix Garroway',
    ]);
    const [task] = await checkIns();
    expect(task).toMatchObject({ assigned_to: ines.userId, created_by: ines.userId });
  });

  it('lists every cadence overdue first', async () => {
    await mailTo('felix@marrowgate.example', 40);
    value(await setCadence(store, org, OWEN, { choice: 'quarterly' }, actor, ago(1)));
    value(await setCadence(store, org, FELIX, { choice: 'monthly' }, actor, ago(1)));
    const rows = value(await listKeepInTouch(store, org, NOW));
    expect(rows.map((r) => [r.record.name, r.status.state])).toEqual([
      ['Felix Garroway', 'overdue'],
      ['Owen Thistlewood', 'on_track'],
    ]);
  });
});

describe('what counts as contact', () => {
  it('ignores a newsletter from a company’s domain, so its check-in still comes due', async () => {
    await mailTo('felix@marrowgate.example', 40);
    await mail('newsletter@marrowgate.example', ['nick@tiptop.demo'], 2);
    const company = (await store.get('crm_records', org, MARROWGATE)) as CrmRecord;
    const profile = value(await keepInTouchFor(store, org, company, NOW));
    expect(profile.evidence).toMatchObject({
      lastContactAt: ago(40).toISOString(),
      lastContactKind: 'outbound',
    });
  });

  it('ignores mass mail, and counts Nick’s aliases as Nick', async () => {
    const crowd = Array.from({ length: 20 }, (_, i) => `reader${i}@lp-list.example`);
    await mail('nick@tiptop.demo', [...crowd, 'felix@marrowgate.example'], 3);
    await mail('nick@tiptopvc.com', ['felix@marrowgate.example'], 9);
    const felix = (await store.get('crm_records', org, FELIX)) as CrmRecord;
    const profile = value(await keepInTouchFor(store, org, felix, NOW));
    expect(profile.evidence).toMatchObject({
      lastContactAt: ago(9).toISOString(),
      lastContactKind: 'outbound',
    });
  });

  it('shows the same last contact as the Relationship panel on the same profile', async () => {
    await mailTo('felix@marrowgate.example', 12);
    await mail('newsletter@marrowgate.example', ['nick@tiptop.demo'], 1);
    for (const id of [MARROWGATE, FELIX]) {
      const found = await getRecord(store, org, id);
      if (!found.ok) throw new Error(found.error.message);
      const { record, memberships, related } = found.value;
      const panel = await getRecordRelationship(
        store,
        org,
        { record, memberships, related },
        { ownAddresses: [], now: NOW },
      );
      if (!panel.ok) throw new Error(panel.error.message);
      const card = value(await keepInTouchFor(store, org, record, NOW));
      expect(card.evidence.lastContactAt).toBe(panel.value.evidence.lastContactAt);
      expect(card.evidence.nextMeetingAt).toBe(panel.value.evidence.nextMeetingAt);
    }
  });
});
