import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import { listLiveThreads, resetInboxLiveCache } from '@/lib/services/inbox-live';
import type { EmailMessage, Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';

/**
 * POST /api/inbox/modify with `action: 'label'`. In demo mode the change is
 * kept on the demo messages and shows in the list; against Gmail it is held
 * to the mailbox's own label list, a numbered label is a move, and every
 * write goes through setThreadLabels (stubbed here: no network).
 */

let harness: Harness;
let live = false;
let names = new Map<string, string>();
const labelReads: number[] = [];

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

const setThreadLabels = vi.fn(async (..._args: unknown[]) => ok(true as const));

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => !live && actual.isDemoMode() };
});

vi.mock('@/lib/google/gmail-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-send')>()),
  setThreadLabels: (...args: unknown[]) => setThreadLabels(...args),
}));

vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
  readLabelNames: async () => {
    labelReads.push(Date.now());
    return new Map(names);
  },
}));

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION : null,
  }),
}));

const { POST } = await import('@/app/api/inbox/modify/route');

const call = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/inbox/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

/** The hex id the Inbox gives a demo thread: the tail of its uuid. */
const demoId = (uuid: string) => uuid.replace(/-/g, '').slice(-16);
const VETRIX = demoId(DEMO_IDS.threadVetrix);

async function demoLabels(threadId: string): Promise<string[]> {
  const messages = (await harness.store.list('email_messages', DEMO_IDS.org, {
    eq: { thread_id: threadId },
  })) as EmailMessage[];
  return [...new Set(messages.flatMap((m) => m.labels))];
}

beforeEach(async () => {
  live = false;
  names = new Map([
    ['INBOX', 'INBOX'],
    ['Label_7101', '1: Reply today'],
    ['Label_7102', '2: This week'],
    ['Label_7103', '3: Waiting on them'],
    ['Label_7201', 'Portfolio'],
  ]);
  labelReads.length = 0;
  setThreadLabels.mockClear();
  resetInboxLiveCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('labels in demo mode', () => {
  it('puts a label on a thread and the list shows it', async () => {
    const res = await call({ ids: [VETRIX], action: 'label', add: ['Label_913'] });
    expect(res.status).toBe(200);
    expect(await demoLabels(DEMO_IDS.threadVetrix)).toContain('Label_913');
    expect(await demoLabels(DEMO_IDS.threadVetrix)).toContain('INBOX');

    const list = await listLiveThreads(harness.store, DEMO_IDS.org, { tab: 'primary' });
    expect(list.canLabel).toBe(true);
    expect(list.labelChoices.map((l) => l.name)).toContain('Portfolio');
    const row = list.rows.find((r) => r.id === VETRIX);
    expect(row?.labels).toEqual(['Portfolio']);
    expect(row?.labelIds).toEqual(['Label_913']);
  });

  it('moves between numbered labels, keeping the plain ones', async () => {
    await call({ ids: [VETRIX], action: 'label', add: ['Label_913'] });
    await call({ ids: [VETRIX], action: 'label', add: ['Label_901'] });
    const res = await call({ ids: [VETRIX], action: 'label', add: ['Label_902'] });
    expect(res.status).toBe(200);
    const labels = await demoLabels(DEMO_IDS.threadVetrix);
    expect(labels).toContain('Label_902');
    expect(labels).toContain('Label_913');
    expect(labels).not.toContain('Label_901');
  });

  it('takes a plain label off, but never a numbered one on its own', async () => {
    await call({ ids: [VETRIX], action: 'label', add: ['Label_913'] });
    await call({ ids: [VETRIX], action: 'label', add: ['Label_901'] });
    expect((await call({ ids: [VETRIX], action: 'label', remove: ['Label_913'] })).status).toBe(
      200,
    );
    const bare = await call({ ids: [VETRIX], action: 'label', remove: ['Label_901'] });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: { message: string } }).error.message).toMatch(
      /swapped/,
    );
    expect(await demoLabels(DEMO_IDS.threadVetrix)).toEqual(
      expect.arrayContaining(['INBOX', 'Label_901']),
    );
  });

  it('refuses system labels, labels the mailbox does not have, and a missing thread', async () => {
    expect((await call({ ids: [VETRIX], action: 'label', add: ['TRASH'] })).status).toBe(400);
    expect((await call({ ids: [VETRIX], action: 'label', add: ['Label_404'] })).status).toBe(400);
    expect((await call({ ids: [VETRIX], action: 'label' })).status).toBe(400);
    expect(
      (await call({ ids: ['ffffffffffffffff'], action: 'label', add: ['Label_913'] })).status,
    ).toBe(404);
  });

  it('still leaves archive and star off in the demo, and never writes to Gmail', async () => {
    expect((await call({ ids: [VETRIX], action: 'archive' })).status).toBe(409);
    expect(setThreadLabels).not.toHaveBeenCalled();
  });
});

describe('labels against Gmail', () => {
  beforeEach(() => {
    live = true;
  });

  it("checks the change against the mailbox's own labels and writes through setThreadLabels", async () => {
    const res = await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7201'] });
    expect(res.status).toBe(200);
    expect(setThreadLabels).toHaveBeenCalledTimes(1);
    expect(setThreadLabels.mock.calls[0]).toEqual([
      harness.store,
      INTEGRATION,
      'aaaa000000000001',
      { add: ['Label_7201'], remove: [] },
    ]);
  });

  it('makes a numbered label a move on every thread it touches', async () => {
    const ids = ['aaaa000000000001', 'aaaa000000000002'];
    const res = await call({ ids, action: 'label', add: ['Label_7102'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: 2, remove: ['Label_7101', 'Label_7103'] });
    for (const [i, id] of ids.entries()) {
      expect(setThreadLabels.mock.calls[i]?.slice(2)).toEqual([
        id,
        { add: ['Label_7102'], remove: ['Label_7101', 'Label_7103'] },
      ]);
    }
  });

  it('moves within a numbered family bigger than one tap may name', async () => {
    for (let n = 4; n <= 14; n++) names.set(`Label_75${n}`, `${n}: Extra`);
    const res = await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7102'] });
    expect(res.status).toBe(200);
    const change = setThreadLabels.mock.calls[0]?.[3] as { add: string[]; remove: string[] };
    expect(change.add).toEqual(['Label_7102']);
    expect(change.remove).toHaveLength(13);
    expect(change.remove).not.toContain('Label_7102');
    expect(change.remove).not.toContain('Label_7201');
  });

  it('reads the labels again once for a label made in Gmail a moment ago', async () => {
    await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7201'] });
    expect(labelReads).toHaveLength(1);
    names.set('Label_7301', 'Board');
    const res = await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7301'] });
    expect(res.status).toBe(200);
    expect(labelReads).toHaveLength(2);
  });

  it('refuses a label that is still not in Gmail after a fresh read, writing nothing', async () => {
    const res = await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7999'] });
    expect(res.status).toBe(400);
    expect(labelReads).toHaveLength(2);
    expect(setThreadLabels).not.toHaveBeenCalled();
  });

  it('keeps the old actions as they were', async () => {
    await call({ ids: ['aaaa000000000001'], action: 'archive' });
    expect(setThreadLabels.mock.calls[0]?.[3]).toEqual({ remove: ['INBOX'] });
  });

  it('needs sending turned on', async () => {
    const scopes = INTEGRATION.scopes;
    INTEGRATION.scopes = [];
    try {
      const res = await call({ ids: ['aaaa000000000001'], action: 'label', add: ['Label_7201'] });
      expect(res.status).toBe(409);
      expect(setThreadLabels).not.toHaveBeenCalled();
    } finally {
      INTEGRATION.scopes = scopes;
    }
  });
});
