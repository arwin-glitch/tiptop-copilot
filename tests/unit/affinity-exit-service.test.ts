import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import {
  AFFINITY_EXIT_ACTION,
  changeAffinityExitSettings,
  getAffinityExitStatus,
  readAffinityExitSettings,
  readAffinityExitTodayLine,
} from '@/lib/services/affinity-exit';
import { INTRODUCTION_ACTION } from '@/lib/services/introductions';

/**
 * The Affinity exit checklist's server side: its settings are data the
 * workspace types in, kept as audit rows (newest wins, nothing assumed), its
 * status is counted from Kraken's own records, and every read degrades to
 * "unknown" or "nothing set" rather than failing the page. Invented data only.
 */

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAuth: mocks.requireAuth,
}));

const { changeAffinityExitAction, runAffinityExitImportAction } =
  await import('@/app/actions/affinity-exit');

const TZ = 'America/Chicago';

let harness: Harness;
let store: DataStore;
let org: string;
let owner: AuthContext;

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  owner = { ...harness.auth, role: 'owner' };
  mocks.requireAuth.mockReset().mockResolvedValue(owner);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AFFINITY_API_KEY;
  resetEnvCache();
  await harness.dispose();
});

const actor = () => ({ userId: harness.auth.userId });

/** A store whose reads of `tables` fail as a table that does not exist yet would. */
function missing(tables: string[]): DataStore {
  const fail = () => Promise.reject(Object.assign(new Error('missing'), { code: 'PGRST205' }));
  return new Proxy(store, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) =>
        tables.includes(String(args[0])) && ['list', 'count', 'findOne'].includes(String(prop))
          ? fail()
          : original.apply(target, args);
    },
  });
}

describe('the checklist settings', () => {
  it('are empty until someone sets them, then the newest change wins', async () => {
    expect(await readAffinityExitSettings(store, org)).toEqual({
      noticeDate: null,
      cancelled: false,
      cancelledAt: null,
      tools: [],
    });
    const now = new Date('2030-03-01T15:00:00Z');
    // Several changes in the same millisecond still land in order.
    await changeAffinityExitSettings(store, org, { op: 'date', date: '2030-03-20' }, actor(), now);
    await changeAffinityExitSettings(
      store,
      org,
      { op: 'add-tool', label: 'Example bridge' },
      actor(),
      now,
    );
    await changeAffinityExitSettings(store, org, { op: 'date', date: '2030-03-15' }, actor(), now);
    const settings = await readAffinityExitSettings(store, org);
    expect(settings.noticeDate).toBe('2030-03-15');
    expect(settings.tools.map((t) => t.label)).toEqual(['Example bridge']);
    const rows = await store.list('audit_events', org, { eq: { action: AFFINITY_EXIT_ACTION } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.user_id === harness.auth.userId)).toBe(true);
  });

  it('refuse a bad change and save nothing', async () => {
    const result = await changeAffinityExitSettings(
      store,
      org,
      { op: 'date', date: '2030-02-31' },
      actor(),
    );
    expect(!result.ok && result.error.code).toBe('invalid_input');
    expect(await store.count('audit_events', org, { eq: { action: AFFINITY_EXIT_ACTION } })).toBe(
      0,
    );
  });

  it('never keep a key pasted into a tool’s name', async () => {
    const result = await changeAffinityExitSettings(
      store,
      org,
      { op: 'add-tool', label: 'Sample sync api_key=abcdefgh12345678' },
      actor(),
    );
    expect(result.ok && result.value.tools[0]?.label).not.toContain('abcdefgh12345678');
    expect(JSON.stringify(await store.list('audit_events', org, {}))).not.toContain(
      'abcdefgh12345678',
    );
  });

  it('read as nothing set when the store cannot be read, and refuse a write politely', async () => {
    const broken = missing(['audit_events']);
    expect((await readAffinityExitSettings(broken, org)).noticeDate).toBeNull();
    const result = await changeAffinityExitSettings(
      broken,
      org,
      { op: 'cancelled', cancelled: true },
      actor(),
    );
    expect(!result.ok && result.error.code).toBe('internal');
  });
});

describe("Today's line", () => {
  it('appears in the last two weeks, and never once cancelled', async () => {
    const now = new Date('2030-03-05T15:00:00Z');
    expect(await readAffinityExitTodayLine(store, org, now, TZ)).toBeNull();
    await changeAffinityExitSettings(store, org, { op: 'date', date: '2030-03-15' }, actor(), now);
    expect(await readAffinityExitTodayLine(store, org, now, TZ)).toEqual({
      dateKey: '2030-03-15',
      daysLeft: 10,
    });
    expect(
      await readAffinityExitTodayLine(store, org, new Date('2030-02-01T15:00:00Z'), TZ),
    ).toBeNull();
    await changeAffinityExitSettings(
      store,
      org,
      { op: 'cancelled', cancelled: true },
      actor(),
      now,
    );
    expect(await readAffinityExitTodayLine(store, org, now, TZ)).toBeNull();
  });

  it('is simply absent when the store fails', async () => {
    const line = await readAffinityExitTodayLine(missing(['audit_events']), org, new Date(), TZ);
    expect(line).toBeNull();
  });
});

describe('the checklist status', () => {
  it('counts what Kraken holds from Affinity, and what the copies did', async () => {
    const now = new Date('2030-03-05T15:00:00Z');
    await changeAffinityExitSettings(store, org, { op: 'date', date: '2030-03-15' }, actor(), now);
    const status = await getAffinityExitStatus(store, org, { now, timeZone: TZ });
    const expected = {
      lists: await store.count('crm_lists', org, { eq: { source: 'affinity' } }),
      companies: await store.count('crm_records', org, {
        eq: { source: 'affinity', kind: 'company' },
      }),
      people: await store.count('crm_records', org, { eq: { source: 'affinity', kind: 'person' } }),
      notes: await store.count('crm_notes', org, { eq: { source: 'affinity' } }),
    };
    expect(expected.lists).toBeGreaterThan(0);
    expect(status).toMatchObject({ crmReady: true, ...expected });
    expect(status.countdown).toEqual({ dateKey: '2030-03-15', daysLeft: 10 });
    // The demo's sync is an invented example, running.
    expect(status.sync).toMatchObject({ state: 'running', demo: true, stoppedAt: null });
    expect(status.imports.contacts.state).toBe('never');
    expect(status.imports.reminders.state).toBe('never');
  });

  it('counts each introduction once, however many profiles it is written under', async () => {
    const row = (intro: string, key: string) => ({
      id: crypto.randomUUID(),
      organization_id: org,
      user_id: null,
      action: INTRODUCTION_ACTION,
      entity_type: 'crm_introduction',
      entity_id: key,
      metadata: { v: 1, intro, role: 'introduced' },
      ip_hash: null,
      created_at: new Date().toISOString(),
    });
    const before =
      (await getAffinityExitStatus(store, org, { timeZone: TZ })).introductions.count ?? 0;
    await store.insertMany('audit_events', [
      row('intro-example-1', 'email:ada@example.demo'),
      row('intro-example-1', 'domain:example.demo'),
      row('intro-example-2', 'email:lin@sample.example'),
    ]);
    const status = await getAffinityExitStatus(store, org, { timeZone: TZ });
    expect(status.introductions).toMatchObject({ count: before + 2, atLeast: false });
  });

  it('shows every CRM number as unknown before the CRM migration, and never fails', async () => {
    const status = await getAffinityExitStatus(
      missing(['crm_lists', 'crm_records', 'crm_list_entries', 'crm_notes']),
      org,
      { timeZone: TZ },
    );
    expect(status).toMatchObject({
      crmReady: false,
      lists: null,
      companies: null,
      people: null,
      notes: null,
    });
  });

  it('still answers when the audit table itself cannot be read', async () => {
    const status = await getAffinityExitStatus(missing(['audit_events']), org, { timeZone: TZ });
    expect(status.settings.noticeDate).toBeNull();
    expect(status.introductions.count).toBeNull();
    expect(status.imports.contacts.state).toBe('never');
  });
});

describe('the checklist actions', () => {
  it('let a member change the checklist, and refuse a viewer', async () => {
    mocks.requireAuth.mockResolvedValue({ ...owner, role: 'member' });
    const added = await changeAffinityExitAction({ op: 'add-tool', label: 'Demo notes bridge' });
    expect(added).toMatchObject({ ok: true, data: { tools: [{ label: 'Demo notes bridge' }] } });

    mocks.requireAuth.mockResolvedValue({ ...owner, role: 'viewer' });
    const refused = await changeAffinityExitAction({ op: 'date', date: '2030-03-15' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuse input that is not a change the page makes', async () => {
    const result = await changeAffinityExitAction({ op: 'date', date: 'next week' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const odd = await changeAffinityExitAction({ op: 'explode' } as never);
    expect(odd).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('keep the copies the owner’s, never call Affinity in the demo, and need the key', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);

    mocks.requireAuth.mockResolvedValue({ ...owner, role: 'member' });
    expect(await runAffinityExitImportAction({ kind: 'contacts', fresh: true })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });

    mocks.requireAuth.mockResolvedValue({ ...owner, isDemo: true });
    expect(await runAffinityExitImportAction({ kind: 'reminders', fresh: true })).toMatchObject({
      ok: true,
      data: { kind: 'reminders', done: true },
    });

    mocks.requireAuth.mockResolvedValue({ ...owner, isDemo: false });
    delete process.env.AFFINITY_API_KEY;
    resetEnvCache();
    const keyless = await runAffinityExitImportAction({ kind: 'contacts', fresh: true });
    expect(keyless).toMatchObject({ ok: false, error: { code: 'not_configured' } });

    expect(await runAffinityExitImportAction({ kind: 'files', fresh: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
