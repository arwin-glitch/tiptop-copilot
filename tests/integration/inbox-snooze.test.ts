import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import { listLiveThreads, resetInboxLiveCache } from '@/lib/services/inbox-live';
import { formatSnoozeCronStatus, wakeDueSnoozes } from '@/lib/services/inbox-snooze';
import type { EmailMessage, InboxSnooze, Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * POST/GET /api/inbox/snooze and the wake step. In demo mode the rows alone
 * carry a snooze and the demo list follows them; against Gmail a snooze
 * takes INBOX off, a wake puts INBOX and UNREAD back, and every write goes
 * through setThreadLabels (stubbed here: no network). Before the migration
 * is run, nothing changes and the route says so.
 */

let harness: Harness;
let live = false;
let sendOn = true;

const INTEGRATION: Integration = {
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: DEMO_IDS.org,
  user_id: DEMO_IDS.user,
  provider: 'google',
  kinds: ['gmail'],
  account_email: 'partner@firm.example',
  scopes: [...SEND_SCOPES],
  status: 'connected',
  status_detail: null,
  last_sync_at: null,
  last_sync_error: null,
  sync_cursor: null,
  watch_expires_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const setThreadLabels = vi.fn(async (..._args: unknown[]): Promise<Result<true>> => ok(true));

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => !live && actual.isDemoMode() };
});

vi.mock('@/lib/google/gmail-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-send')>()),
  setThreadLabels: (...args: unknown[]) => setThreadLabels(...args),
}));

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? { ...INTEGRATION, scopes: sendOn ? [...SEND_SCOPES] : [] } : null,
  }),
}));

const { GET, POST } = await import('@/app/api/inbox/snooze/route');

const call = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/inbox/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const demoId = (uuid: string) => uuid.replace(/-/g, '').slice(-16);
const VETRIX = demoId(DEMO_IDS.threadVetrix);
const GIRDER = demoId(DEMO_IDS.threadGirder);
const GMAIL_ID = '18c2f0a9b7d3e1f4';

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function snoozeRows(): Promise<InboxSnooze[]> {
  return (await harness.store.list('inbox_snoozes', DEMO_IDS.org, {})) as InboxSnooze[];
}

beforeEach(async () => {
  live = false;
  sendOn = true;
  setThreadLabels.mockReset();
  setThreadLabels.mockImplementation(async () => ok(true as const));
  resetInboxLiveCache();
  harness = await createHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe('snooze in demo mode', () => {
  it('takes the thread out of Primary, lists it under Snoozed, and Unsnooze brings it back', async () => {
    const wakeAt = inHours(5);
    const res = await call({ action: 'snooze', threadIds: [VETRIX], wakeAt });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ids: [VETRIX] });
    expect(setThreadLabels).not.toHaveBeenCalled();

    const primary = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    expect(primary.canSnooze).toBe(true);
    expect(primary.snoozeReady).toBe(true);
    expect(primary.rows.some((r) => r.id === VETRIX)).toBe(false);

    const snoozed = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'snoozed' });
    expect(snoozed.rows.map((r) => r.id)).toEqual([VETRIX]);
    expect(snoozed.rows[0]?.snoozedUntil).toBe(new Date(wakeAt).toISOString());

    const list = (await (await GET()).json()) as { state: string; snoozes: unknown[] };
    expect(list.state).toBe('ok');
    expect(list.snoozes).toEqual([{ threadId: VETRIX, wakeAt: new Date(wakeAt).toISOString() }]);

    expect((await call({ action: 'unsnooze', threadIds: [VETRIX] })).status).toBe(200);
    const back = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    expect(back.rows.some((r) => r.id === VETRIX)).toBe(true);
    expect((await snoozeRows()).map((r) => r.status)).toEqual(['cancelled']);
  });

  it('snoozing again replaces the open snooze', async () => {
    await call({ action: 'snooze', threadIds: [VETRIX], wakeAt: inHours(2) });
    await call({ action: 'snooze', threadIds: [VETRIX], wakeAt: inHours(30) });
    const rows = await snoozeRows();
    expect(rows.filter((r) => r.status === 'snoozed')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(1);
  });

  it('wakes a due snooze when the list loads: back in Primary, unread', async () => {
    await call({ action: 'snooze', threadIds: [VETRIX], wakeAt: inHours(1) });
    const messages = (await harness.store.list('email_messages', DEMO_IDS.org, {
      eq: { thread_id: DEMO_IDS.threadVetrix },
    })) as EmailMessage[];
    for (const m of messages) {
      await harness.store.update('email_messages', DEMO_IDS.org, m.id, { is_unread: false });
    }
    const later = new Date(Date.now() + 2 * 3_600_000);
    const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary', now: later });
    const row = list.rows.find((r) => r.id === VETRIX);
    expect(row).toBeDefined();
    expect(row?.unread).toBe(true);
    expect((await snoozeRows()).map((r) => r.status)).toEqual(['woken']);
  });
});

describe('the route checks what it is given', () => {
  it.each([
    ['a bad thread id', { action: 'snooze', threadIds: ['not-an-id'], wakeAt: inHours(1) }],
    ['no thread', { action: 'snooze', threadIds: [], wakeAt: inHours(1) }],
    [
      'too many threads',
      { action: 'snooze', threadIds: Array(101).fill(VETRIX), wakeAt: inHours(1) },
    ],
    ['no wake time', { action: 'snooze', threadIds: [VETRIX] }],
    ['an unknown action', { action: 'trash', threadIds: [VETRIX] }],
    ['no body', null],
  ])('refuses %s', async (_name, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await snoozeRows()).toEqual([]);
  });

  it('refuses a wake time in the past, now-ish, or more than a year ahead', async () => {
    for (const wakeAt of [
      new Date(Date.now() - 60_000).toISOString(),
      'next tuesday',
      new Date(Date.now() + 367 * 86_400_000).toISOString(),
    ]) {
      const res = await call({ action: 'snooze', threadIds: [VETRIX], wakeAt });
      expect(res.status, wakeAt).toBe(400);
    }
    expect(await snoozeRows()).toEqual([]);
  });

  it('stores the id lower-cased, once', async () => {
    const res = await call({
      action: 'snooze',
      threadIds: [GIRDER.toUpperCase(), GIRDER],
      wakeAt: inHours(3),
    });
    expect(res.status).toBe(200);
    expect((await snoozeRows()).map((r) => r.thread_id)).toEqual([GIRDER]);
  });
});

describe('snooze against Gmail', () => {
  beforeEach(() => {
    live = true;
  });

  it('takes INBOX off, then keeps the row', async () => {
    const res = await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(4) });
    expect(res.status).toBe(200);
    expect(setThreadLabels).toHaveBeenCalledTimes(1);
    expect(setThreadLabels.mock.calls[0]?.[2]).toBe(GMAIL_ID);
    expect(setThreadLabels.mock.calls[0]?.[3]).toEqual({ remove: ['INBOX'] });
    expect((await snoozeRows()).map((r) => [r.thread_id, r.status])).toEqual([
      [GMAIL_ID, 'snoozed'],
    ]);
  });

  it('keeps no row when Gmail refuses', async () => {
    setThreadLabels.mockImplementation(async () => err('provider_unavailable', 'no'));
    const res = await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(4) });
    expect(res.status).toBe(502);
    expect(await snoozeRows()).toEqual([]);
  });

  it('needs sending turned on', async () => {
    sendOn = false;
    const res = await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(4) });
    expect(res.status).toBe(403);
    expect(setThreadLabels).not.toHaveBeenCalled();
  });

  it('unsnooze puts INBOX back and cancels the row', async () => {
    await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(4) });
    setThreadLabels.mockClear();
    expect((await call({ action: 'unsnooze', threadIds: [GMAIL_ID] })).status).toBe(200);
    expect(setThreadLabels.mock.calls[0]?.[3]).toEqual({ add: ['INBOX'] });
    expect((await snoozeRows())[0]?.status).toBe('cancelled');
  });

  it('wakes due threads with INBOX and UNREAD, and leaves a refused one for the next run', async () => {
    await call({ action: 'snooze', threadIds: [GMAIL_ID, 'abcdef0123456789'], wakeAt: inHours(1) });
    setThreadLabels.mockReset();
    setThreadLabels.mockImplementation(async (...args: unknown[]) =>
      args[2] === GMAIL_ID ? ok(true as const) : err('provider_unavailable', 'busy'),
    );
    const later = new Date(Date.now() + 2 * 3_600_000);
    const notYet = await wakeDueSnoozes(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
    });
    expect(notYet).toEqual({ state: 'ok', woken: [], failed: 0 });

    const summary = await wakeDueSnoozes(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: later,
    });
    expect(summary).toEqual({ state: 'ok', woken: [GMAIL_ID], failed: 1 });
    expect(setThreadLabels.mock.calls.map((c) => c[3])).toEqual([
      { add: ['INBOX', 'UNREAD'] },
      { add: ['INBOX', 'UNREAD'] },
    ]);
    expect(formatSnoozeCronStatus(summary)).toBe('ok: 1 woken, 1 left for the next run');
    const statuses = Object.fromEntries((await snoozeRows()).map((r) => [r.thread_id, r.status]));
    expect(statuses).toEqual({ [GMAIL_ID]: 'woken', abcdef0123456789: 'snoozed' });
  });

  it('closes the row of a thread Gmail no longer has', async () => {
    await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(1) });
    setThreadLabels.mockImplementation(async () =>
      err('provider_unavailable', 'gone', { details: { status: 404 } }),
    );
    const summary = await wakeDueSnoozes(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: INTEGRATION,
      now: new Date(Date.now() + 2 * 3_600_000),
    });
    expect(summary.woken).toEqual([GMAIL_ID]);
    expect((await snoozeRows())[0]?.status).toBe('woken');
  });

  it('does not wake without a mailbox that can send', async () => {
    await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(1) });
    const summary = await wakeDueSnoozes(harness.store, DEMO_IDS.org, {
      demo: false,
      integration: { ...INTEGRATION, scopes: [] },
      now: new Date(Date.now() + 2 * 3_600_000),
    });
    expect(summary).toEqual({ state: 'not_connected', woken: [], failed: 1 });
    expect((await snoozeRows())[0]?.status).toBe('snoozed');
  });
});

describe('before the migration is run', () => {
  const missing = () => {
    const original = harness.store.list.bind(harness.store);
    vi.spyOn(harness.store, 'list').mockImplementation((async (
      table: string,
      ...rest: unknown[]
    ) => {
      if (table === 'inbox_snoozes') {
        throw Object.assign(new Error('relation "inbox_snoozes" does not exist'), {
          code: '42P01',
        });
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(table, ...rest);
    }) as never);
  };

  it('says it needs a database update and changes nothing in Gmail', async () => {
    live = true;
    missing();
    const res = await call({ action: 'snooze', threadIds: [GMAIL_ID], wakeAt: inHours(4) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; details?: object } };
    expect(body.error.message).toMatch(/needs a database update/);
    expect(body.error.details).toEqual({ needsMigration: true });
    expect(setThreadLabels).not.toHaveBeenCalled();
  });

  it('keeps the demo list working, and waking does nothing', async () => {
    missing();
    const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    expect(list.state).toBe('ok');
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.snoozeReady).toBe(false);
    const summary = await wakeDueSnoozes(harness.store, DEMO_IDS.org, { demo: true });
    expect(summary.state).toBe('needs_migration');
    expect(formatSnoozeCronStatus(summary)).toBe('skipped: needs database update');
    const listed = (await (await GET()).json()) as { state: string };
    expect(listed.state).toBe('needs_migration');
  });
});

describe('what Snooze may write', () => {
  it('only ever takes INBOX off, or puts INBOX and UNREAD on', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../src/lib/services/inbox-snooze.ts'),
      'utf8',
    );
    const changes = [...source.matchAll(/setThreadLabels\([^)]*?\{([^}]*)\}/g)].map((m) =>
      m[1]!.replace(/\s+/g, ' ').trim(),
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(
        [
          "remove: ['INBOX']",
          "add: ['INBOX']",
          "add: ['INBOX', 'UNREAD'],",
          "add: ['INBOX', 'UNREAD']",
        ],
        change,
      ).toContain(change);
    }
    expect(source).not.toMatch(/TRASH|SPAM|\/trash|delete\(/);
  });
});
