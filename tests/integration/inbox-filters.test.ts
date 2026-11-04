import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { FILTER_SCOPES, SEND_SCOPES } from '@/lib/google/send-scopes';
import { listLiveThreads, resetInboxLiveCache } from '@/lib/services/inbox-live';
import { resetDemoFilters } from '@/lib/services/inbox-filters';
import type { Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';

/**
 * The Inbox's Create filter and Filters list (/api/inbox/filters), and the
 * search box's type-ahead (/api/inbox/suggest). The demo keeps filters in
 * memory; against Gmail the filter module and the label path are stubbed
 * (no network), so the test sees exactly what would be sent.
 */

let harness: Harness;
let live = false;
let scopes: string[] = [];

const INTEGRATION = (): Integration => ({
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: DEMO_IDS.org,
  user_id: DEMO_IDS.user,
  provider: 'google',
  kinds: ['gmail'],
  account_email: 'partner@firm.example',
  scopes,
  status: 'connected',
  status_detail: null,
  last_sync_at: null,
  last_sync_error: null,
  sync_cursor: null,
  watch_expires_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const createFilter = vi.fn(async (..._args: unknown[]) => ok({ id: 'ANe1BmhGfilter01' }));
const listFilters = vi.fn(async (..._args: unknown[]) => ok([]));
const deleteFilter = vi.fn(async (..._args: unknown[]) => ok(true as const));
const setThreadLabels = vi.fn(async (..._args: unknown[]) => ok(true as const));
const createLabel = vi.fn(async (..._args: unknown[]) => ok({ id: 'Label_7299', name: 'Blocked' }));
const listThreadPage = vi.fn(async (..._args: unknown[]) =>
  ok({
    threads: [
      { id: '18c0a1b2c3d4e5f6', snippet: '', historyId: '1' },
      { id: '18c0a1b2c3d4e5f7', snippet: '', historyId: '1' },
    ],
    nextPageToken: null,
    total: 2,
  }),
);

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => !live && actual.isDemoMode() };
});

vi.mock('@/lib/google/gmail-filters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-filters')>()),
  createFilter: (...args: unknown[]) => createFilter(...args),
  listFilters: (...args: unknown[]) => listFilters(...args),
  deleteFilter: (...args: unknown[]) => deleteFilter(...args),
}));

vi.mock('@/lib/google/gmail-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-send')>()),
  setThreadLabels: (...args: unknown[]) => setThreadLabels(...args),
  createLabel: (...args: unknown[]) => createLabel(...args),
}));

vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
  listThreadPage: (...args: unknown[]) => listThreadPage(...args),
  readLabelDirectory: async () => ({
    names: new Map([
      ['INBOX', 'INBOX'],
      ['Label_7201', 'Portfolio'],
    ]),
    colors: new Map(),
  }),
}));

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION() : null,
  }),
}));

const filters = await import('@/app/api/inbox/filters/route');
const suggest = await import('@/app/api/inbox/suggest/route');
const block = await import('@/app/api/inbox/block/route');

const postBlock = (address: string) =>
  block.POST(
    new NextRequest('http://localhost/api/inbox/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    }),
  );

const post = (body: unknown) =>
  filters.POST(
    new NextRequest('http://localhost/api/inbox/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const del = (id: string) =>
  filters.DELETE(
    new NextRequest(`http://localhost/api/inbox/filters?id=${id}`, { method: 'DELETE' }),
  );

const blankCriteria = {
  from: '',
  to: '',
  subject: '',
  hasWords: '',
  doesntHave: '',
  hasAttachment: false,
};

beforeEach(async () => {
  live = false;
  scopes = [];
  for (const m of [
    createFilter,
    listFilters,
    deleteFilter,
    setThreadLabels,
    listThreadPage,
    createLabel,
  ]) {
    m.mockClear();
  }
  resetInboxLiveCache();
  resetDemoFilters();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('filters in demo mode', () => {
  it('creates, applies, lists and deletes a filter without reaching Gmail', async () => {
    const before = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    const target = before.rows.find((r) => r.inInbox)!;
    expect(target).toBeTruthy();

    const read = await (await filters.GET()).json();
    expect(read.access.state).toBe('demo');
    expect(read.filters).toEqual([]);

    const res = await post({
      criteria: { ...blankCriteria, subject: target.subject },
      actions: { skipInbox: true, star: true },
      applyExisting: true,
    });
    expect(res.status).toBe(200);
    const made = await res.json();
    expect(made.applied).toBeGreaterThanOrEqual(1);
    expect(createFilter).not.toHaveBeenCalled();

    const after = await listLiveThreads(harness.store, DEMO_IDS.org, { folder: 'starred' });
    expect(after.rows.map((r) => r.id)).toContain(target.id);
    const inbox = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    expect(inbox.rows.map((r) => r.id)).not.toContain(target.id);

    const listed = await (await filters.GET()).json();
    expect(listed.filters).toHaveLength(1);
    expect(listed.filters[0].action).toEqual({
      addLabelIds: ['STARRED'],
      removeLabelIds: ['INBOX'],
    });

    expect((await del(listed.filters[0].id)).status).toBe(200);
    expect((await (await filters.GET()).json()).filters).toEqual([]);
  });

  it('refuses a filter with no criteria, no actions, or a forward field', async () => {
    expect((await post({ criteria: blankCriteria, actions: { star: true } })).status).toBe(400);
    expect(
      (await post({ criteria: { ...blankCriteria, from: 'a@b.example' }, actions: {} })).status,
    ).toBe(400);
    expect(
      (
        await post({
          criteria: { ...blankCriteria, from: 'a@b.example' },
          actions: { star: true, forward: 'x@y.example' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          criteria: { ...blankCriteria, from: 'a@b.example' },
          actions: { star: true, trash: true },
        })
      ).status,
    ).toBe(400);
  });

  it('type-ahead suggests matching demo conversations and people', async () => {
    const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    const word = list.rows[0]!.subject.split(/\s+/).find((w) => w.length > 3)!;
    const res = await suggest.GET(
      new NextRequest(`http://localhost/api/inbox/suggest?q=${encodeURIComponent(word)}`),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.threads.length).toBeGreaterThan(0);
    expect(body.threads.length).toBeLessThanOrEqual(5);
    expect(Array.isArray(body.people)).toBe(true);

    const empty = await (
      await suggest.GET(new NextRequest('http://localhost/api/inbox/suggest?q='))
    ).json();
    expect(empty).toEqual({ ok: true, people: [], threads: [] });
  });
});

describe('filters against Gmail', () => {
  beforeEach(() => {
    live = true;
  });

  it('shows the Turn on filters step until the scope is granted, and refuses to create', async () => {
    scopes = [...SEND_SCOPES];
    const read = await (await filters.GET()).json();
    expect(read.access).toEqual({ state: 'off', canApplyExisting: true });
    expect(listFilters).not.toHaveBeenCalled();
    const res = await post({
      criteria: { ...blankCriteria, from: 'news@digest.example' },
      actions: { markRead: true },
    });
    expect(res.status).toBe(403);
    expect(createFilter).not.toHaveBeenCalled();
  });

  it('sends Gmail only the offered actions, and applies them to matching mail on request', async () => {
    scopes = [...SEND_SCOPES, ...FILTER_SCOPES];
    const res = await post({
      criteria: { ...blankCriteria, from: 'news@digest.example' },
      actions: { skipInbox: true, label: 'Label_7201', category: 'CATEGORY_UPDATES' },
      applyExisting: true,
    });
    expect(res.status).toBe(200);
    expect(createFilter).toHaveBeenCalledTimes(1);
    const body = createFilter.mock.calls[0]![2] as Record<string, unknown>;
    expect(body).toEqual({
      criteria: { from: 'news@digest.example' },
      action: { addLabelIds: ['Label_7201', 'CATEGORY_UPDATES'], removeLabelIds: ['INBOX'] },
    });
    expect(listThreadPage.mock.calls[0]![2]).toMatchObject({ q: 'from:news@digest.example' });
    // Categories apply to new mail only: the label path gets inbox and the label.
    expect(setThreadLabels).toHaveBeenCalledTimes(2);
    expect(setThreadLabels.mock.calls[0]![3]).toEqual({
      add: ['Label_7201'],
      remove: ['INBOX'],
    });
    expect((await res.json()).applied).toBe(2);
  });

  it("refuses a label that is not one of the person's own", async () => {
    scopes = [...SEND_SCOPES, ...FILTER_SCOPES];
    const res = await post({
      criteria: { ...blankCriteria, from: 'news@digest.example' },
      actions: { label: 'Label_9999' },
    });
    expect(res.status).toBe(400);
    expect(createFilter).not.toHaveBeenCalled();
  });

  it('without sending on, the filter is made but nothing existing changes', async () => {
    scopes = [...FILTER_SCOPES];
    const res = await post({
      criteria: { ...blankCriteria, from: 'news@digest.example' },
      actions: { markRead: true },
      applyExisting: true,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(0);
    expect(setThreadLabels).not.toHaveBeenCalled();
  });

  it('deletes a filter only by its id', async () => {
    scopes = [...FILTER_SCOPES];
    expect((await del('ANe1BmhGfilter01')).status).toBe(200);
    expect(deleteFilter).toHaveBeenCalledTimes(1);
    expect((await del('bad id!')).status).toBe(400);
  });
});

describe('Block sender', () => {
  it('in the demo: makes the Blocked label and a skip-inbox filter, then Unblock deletes it', async () => {
    const res = await postBlock('Pat Lane <pat@lane-ventures.demo>');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe('pat@lane-ventures.demo');
    expect(createFilter).not.toHaveBeenCalled();
    expect(createLabel).not.toHaveBeenCalled();
    const listed = await (await filters.GET()).json();
    const blocked = listed.labels.find((l: { name: string }) => l.name === 'Blocked');
    expect(blocked).toBeTruthy();
    expect(listed.filters).toHaveLength(1);
    expect(listed.filters[0].criteria).toEqual({ from: 'pat@lane-ventures.demo' });
    expect(listed.filters[0].action).toEqual({
      addLabelIds: [blocked.id],
      removeLabelIds: ['INBOX', 'UNREAD'],
    });
    expect((await del(listed.filters[0].id)).status).toBe(200);
  });

  it('refuses a value with no address', async () => {
    expect((await postBlock('Just a name')).status).toBe(400);
  });

  it('live: refuses without the filters opt-in', async () => {
    live = true;
    scopes = [...SEND_SCOPES];
    expect((await postBlock('pat@lane.example')).status).toBe(403);
    expect(createFilter).not.toHaveBeenCalled();
  });

  it('live: creates the Blocked label once, then a filter that never adds SPAM or TRASH', async () => {
    live = true;
    scopes = [...SEND_SCOPES, ...FILTER_SCOPES];
    const res = await postBlock('pat@lane.example');
    expect(res.status).toBe(200);
    expect(createLabel).toHaveBeenCalledTimes(1);
    const sent = createFilter.mock.calls[0]![2] as {
      criteria: unknown;
      action: { addLabelIds?: string[]; removeLabelIds?: string[] };
    };
    expect(sent.criteria).toEqual({ from: 'pat@lane.example' });
    expect(sent.action.addLabelIds).toEqual(['Label_7299']);
    expect(sent.action.removeLabelIds).toEqual(['INBOX', 'UNREAD']);
    expect(JSON.stringify(sent)).not.toMatch(/SPAM|TRASH|forward/);
  });
});
