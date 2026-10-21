import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { setGmailWaitForTests } from '@/lib/google/gmail-get';
import { getAccessToken } from '@/lib/google/oauth';
import {
  MAX_EARLIER,
  MAX_TEXT,
  readFollowUpEmail,
  resetFollowUpEmailCache,
  toFollowUpEmail,
} from '@/lib/services/follow-up-email';
import type { LiveMessage, LiveThread } from '@/lib/services/inbox-live';
import type { Integration } from '@/lib/types/domain';
import { err } from '@/lib/util/result';

/**
 * The full email behind a follow-up: read from Gmail through the mailbox gate
 * with a short deadline, a message id led to its thread, cached a minute, and
 * every failure said in words a person can act on. Gmail is a mocked fetch
 * and every name and address is fictional.
 */

vi.mock('@/lib/google/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/oauth')>()),
  getAccessToken: vi.fn(async () => ({ ok: true, value: 'test-access-value' })),
}));

const ORG = 'org-1';
const INTEGRATION = {
  id: 'int-1',
  status: 'connected',
  account_email: 'nick@tiptop.demo',
  scopes: [],
} as unknown as Integration;
const STORE = { list: async () => [INTEGRATION] } as unknown as DataStore;
const E = { demoMode: false, authAllowedDomains: ['tiptop.demo'] } as unknown as AppEnv;

const THREAD = '0b00000000000001';
const MESSAGE = '0b000000000000f3';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const notFound = () =>
  json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);

function message(id: string, from: string, text: string, at: string, labelIds = ['INBOX']) {
  return {
    id,
    labelIds,
    internalDate: String(Date.parse(at)),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'Nick Tippmann <nick@tiptop.demo>' },
        { name: 'Subject', value: 'Seed round timing' },
      ],
      body: { data: Buffer.from(text).toString('base64url') },
    },
  };
}

const gmailThread = (id = THREAD) => ({
  id,
  messages: [
    message(
      '0b00000000000001',
      'Rosa Vance <rosa@quillworks.demo>',
      'Are you in?',
      '2026-10-01T12:00:00Z',
    ),
    message(
      '0b00000000000002',
      'Nick Tippmann <nick@tiptop.demo>',
      'Looking now.',
      '2026-10-02T12:00:00Z',
    ),
    message(
      '0b00000000000003',
      'Rosa Vance <rosa@quillworks.demo>',
      'Closing Friday.',
      '2026-10-03T12:00:00Z',
    ),
    // An unsent reply: never the email being answered.
    message(
      '0b00000000000004',
      'Nick Tippmann <nick@tiptop.demo>',
      'Draft',
      '2026-10-04T12:00:00Z',
      ['DRAFT'],
    ),
  ],
});

/** A fetch that answers with each response in turn, recording the URLs. */
function gmail(...responses: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input).replace('https://gmail.googleapis.com/gmail/v1/users/me', ''));
    const next = responses.shift();
    if (!next) throw new Error('no more mocked Gmail responses');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, calls: () => fetchMock.mock.calls.length };
}

let waits: number[];

beforeEach(() => {
  resetFollowUpEmailCache();
  waits = [];
  setGmailWaitForTests(async (ms) => {
    waits.push(ms);
  });
});

afterEach(() => {
  setGmailWaitForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const read = (id: string, options: Parameters<typeof readFollowUpEmail>[3] = {}) =>
  readFollowUpEmail(STORE, ORG, id, { e: E, ...options });

describe('reading the full email', () => {
  it('reads the thread once and answers its newest real message, drafts left out', async () => {
    const g = gmail(() => json(gmailThread()));
    const res = await read(THREAD);
    expect(g.urls).toEqual([`/threads/${THREAD}?format=full`]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.threadId).toBe(THREAD);
    expect(res.value.subject).toBe('Seed round timing');
    expect(res.value.focus).toMatchObject({
      fromName: 'Rosa Vance',
      text: 'Closing Friday.',
      fromUs: false,
      truncated: false,
    });
    expect(res.value.earlier.map((m) => [m.text, m.fromUs])).toEqual([
      ['Are you in?', false],
      ['Looking now.', true],
    ]);
    expect(res.value.earlierHidden).toBe(0);
  });

  it('follows a message id to its thread, and keeps it under both ids', async () => {
    const g = gmail(
      notFound,
      () => json({ id: MESSAGE, threadId: THREAD }),
      () => json(gmailThread()),
    );
    const res = await read(MESSAGE);
    expect(res.ok).toBe(true);
    expect(g.urls).toEqual([
      `/threads/${MESSAGE}?format=full`,
      `/messages/${MESSAGE}?format=minimal`,
      `/threads/${THREAD}?format=full`,
    ]);
    expect((await read(MESSAGE)).ok).toBe(true);
    expect((await read(THREAD)).ok).toBe(true);
    expect(g.calls()).toBe(3);
  });

  it('waits out a short rate limit through the mailbox gate', async () => {
    const g = gmail(
      () => json({ error: { code: 429 } }, 429, { 'retry-after': '1' }),
      () => json(gmailThread()),
    );
    const res = await read(THREAD);
    expect(res.ok).toBe(true);
    expect(g.calls()).toBe(2);
    expect(waits).toContain(1_000);
  });

  it('says Gmail is busy, with a retry, when the rate limit outlasts the deadline', async () => {
    const g = gmail(() => json({ error: { code: 429 } }, 429, { 'retry-after': '30' }));
    const res = await read(THREAD);
    expect(g.calls()).toBe(1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({
      code: 'rate_limited',
      message: 'Gmail is busy right now. Give it a minute.',
      retryable: true,
    });
  });

  it('says the email is gone when neither a thread nor a message has the id, and remembers it', async () => {
    const g = gmail(notFound, notFound);
    const res = await read(MESSAGE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('not_found');
      expect(res.error.message).toBe('This email is no longer in Gmail.');
      expect(res.error.retryable).toBeUndefined();
    }
    expect((await read(MESSAGE)).ok).toBe(false);
    expect(g.calls()).toBe(2);
  });

  it('a rate limit while finding the thread says busy, not gone', async () => {
    gmail(notFound, () => json({ error: { code: 429 } }, 429, { 'retry-after': '30' }));
    const res = await read(MESSAGE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
  });

  it('shares one read between two callers asking at once', async () => {
    const g = gmail(() => json(gmailThread()));
    const [a, b] = await Promise.all([read(THREAD), read(THREAD)]);
    expect(a.ok && b.ok).toBe(true);
    expect(g.calls()).toBe(1);
  });

  it('reads again once the copy is a minute old, or when asked for a fresh one', async () => {
    const t0 = Date.parse('2026-10-19T12:00:00Z');
    const g = gmail(
      () => json(gmailThread()),
      () => json(gmailThread()),
      () => json(gmailThread()),
    );
    await read(THREAD, { now: t0 });
    await read(THREAD, { now: t0 + 30_000 });
    expect(g.calls()).toBe(1);
    await read(THREAD, { now: t0 + 30_000, fresh: true });
    expect(g.calls()).toBe(2);
    await read(THREAD, { now: t0 + 30_000 + 61_000 });
    expect(g.calls()).toBe(3);
  });

  it('keeps no failure but a missing email: the next read asks Gmail again', async () => {
    const g = gmail(
      // A 5xx is tried again (four tries in all) within the deadline.
      () => json({}, 502),
      () => json({}, 502),
      () => json({}, 502),
      () => json({}, 502),
      () => json(gmailThread()),
    );
    const first = await read(THREAD);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.message).toBe("Gmail didn't answer.");
      expect(first.error.retryable).toBe(true);
    }
    expect((await read(THREAD)).ok).toBe(true);
    expect(g.calls()).toBe(5);
  });

  it('a 4xx Gmail will not explain points to Gmail, with no retry', async () => {
    gmail(() => json({ error: { code: 400 } }, 400));
    const res = await read(THREAD);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('provider_unavailable');
      expect(res.error.message).toBe(
        'Gmail would not open this email here. Open it in Gmail instead.',
      );
      expect(res.error.retryable).toBeUndefined();
    }
  });

  it('a revoked Google grant asks for reconnecting, with no retry', async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce(
      err('provider_unauthorized', 'This Google connection needs to be re-authorised.'),
    );
    const g = gmail();
    const res = await read(THREAD);
    expect(g.calls()).toBe(0);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('provider_unauthorized');
      expect(res.error.message).toMatch(/reconnecting in Settings › Integrations/);
      expect(res.error.retryable).toBeUndefined();
    }
  });

  it('asks Gmail nothing for a bad id, a missing mailbox, or an open sign-in', async () => {
    const g = gmail();
    const bad = await read('zz');
    expect(!bad.ok && bad.error.code).toBe('invalid_input');

    const none = await read(THREAD, { integration: null });
    expect(!none.ok && none.error.code).toBe('not_configured');
    const off = await read(THREAD, {
      integration: { ...INTEGRATION, status: 'disconnected' } as Integration,
    });
    expect(!off.ok && off.error.code).toBe('not_configured');

    const open = await read(THREAD, { e: { ...E, authAllowedDomains: [] } as AppEnv });
    expect(!open.ok && open.error.code).toBe('forbidden');
    expect(g.calls()).toBe(0);
  });

  it('serves the demo its fictional emails without a mailbox', async () => {
    const g = gmail();
    const res = await read('0f0000000000c101', { e: { ...E, demoMode: true } as AppEnv });
    expect(g.calls()).toBe(0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.focus.fromName).toBe('Dana Whitfield');
      expect(res.value.earlier).toHaveLength(2);
      expect(res.value.earlier[1]?.fromUs).toBe(true);
    }
  });
});

describe('toFollowUpEmail', () => {
  const live = (id: string, text: string): LiveMessage => ({
    id,
    fromName: 'Rosa Vance',
    from: 'Rosa Vance <rosa@quillworks.demo>',
    to: 'nick@tiptop.demo',
    cc: '',
    at: '2026-10-01T12:00:00.000Z',
    text,
    attachments: [],
    fromUs: false,
    flagged: false,
  });
  const thread = (messages: LiveMessage[]): LiveThread => ({
    id: THREAD,
    subject: 'Seed round timing',
    unread: false,
    starred: false,
    inInbox: true,
    labels: [],
    labelIds: [],
    messages,
  });

  it('caps a very long message and says so', () => {
    const email = toFollowUpEmail(thread([live('m1', 'a'.repeat(MAX_TEXT + 500))]))!;
    expect(email.focus.text).toHaveLength(MAX_TEXT);
    expect(email.focus.truncated).toBe(true);
  });

  it(`sends the ${MAX_EARLIER} messages before the newest, oldest first, and counts the rest`, () => {
    const many = Array.from({ length: 25 }, (_, i) => live(`m${i}`, `message ${i}`));
    const email = toFollowUpEmail(thread(many))!;
    expect(email.focus.text).toBe('message 24');
    expect(email.earlier.map((m) => m.text)).toEqual([
      'message 19',
      'message 20',
      'message 21',
      'message 22',
      'message 23',
    ]);
    expect(email.earlierHidden).toBe(19);
  });

  it('a single message has nothing earlier; an empty thread has no email', () => {
    expect(toFollowUpEmail(thread([live('m1', 'Hello')]))).toMatchObject({
      earlier: [],
      earlierHidden: 0,
    });
    expect(toFollowUpEmail(thread([]))).toBeNull();
  });
});
