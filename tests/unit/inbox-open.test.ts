import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { setGmailWaitForTests } from '@/lib/google/gmail-get';
import { liveRowFromThread, openLiveThread, resetInboxLiveCache } from '@/lib/services/inbox-live';
import type { Integration } from '@/lib/types/domain';

/**
 * Opening one conversation from a link (`/inbox?thread=<id>`) against a
 * mocked Gmail: a thread id or a message id, wherever the thread is filed,
 * read with GETs only (nothing marked read, no label touched), and every
 * failure said in words a person can act on. Every name and address is
 * fictional.
 */

vi.mock('@/lib/google/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/oauth')>()),
  getAccessToken: vi.fn(async () => ({ ok: true, value: 'test-access-value' })),
}));

const ORG = 'org-1';
const INTEGRATION = {
  id: 'int-open-1',
  status: 'connected',
  account_email: 'nick@tiptop.demo',
  scopes: [],
} as unknown as Integration;
const STORE = { list: async () => [INTEGRATION] } as unknown as DataStore;
const NONE = { list: async () => [] } as unknown as DataStore;
const E = { demoMode: false, authAllowedDomains: ['tiptop.demo'] } as unknown as AppEnv;

const THREAD = '0c00000000000001';
const MESSAGE = '0c000000000000f2';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
const notFound = () =>
  json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);

/** An archived thread (no INBOX label), unread, with a user label. */
const gmailThread = () => ({
  id: THREAD,
  messages: [
    {
      id: MESSAGE,
      labelIds: ['UNREAD', 'Label_3'],
      internalDate: String(Date.parse('2026-10-15T12:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Ada Example <ada@school.demo>' },
          { name: 'To', value: 'Nick Tippmann <nick@tiptop.demo>' },
          { name: 'Subject', value: 'Mentoring this fall' },
        ],
        body: { data: Buffer.from('Would two calls work?').toString('base64url') },
      },
    },
  ],
});

function gmail(...responses: (() => Response)[]) {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input).replace('https://gmail.googleapis.com/gmail/v1/users/me', ''),
      method: init?.method ?? 'GET',
    });
    const next = responses.shift();
    if (!next) throw new Error('no more mocked Gmail responses');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  resetInboxLiveCache();
  setGmailWaitForTests(async () => {});
});

afterEach(() => {
  setGmailWaitForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (id: string, store = STORE) => openLiveThread(store, ORG, id, { e: E });

describe('opening a conversation from a link', () => {
  it('opens an archived thread by its id, with GETs only', async () => {
    const calls = gmail(
      () => json(gmailThread()),
      () => json({ labels: [{ id: 'Label_3', name: 'Students' }] }),
    );
    const res = await open(THREAD);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      id: THREAD,
      subject: 'Mentoring this fall',
      inInbox: false,
      unread: true,
      labels: ['Students'],
    });
    expect(calls.map((c) => c.url)).toEqual([`/threads/${THREAD}?format=full`, '/labels']);
    // Reading never writes: no modify, no POST.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(liveRowFromThread(res.value)).toMatchObject({
      id: THREAD,
      who: 'Ada Example',
      subject: 'Mentoring this fall',
      snippet: 'Would two calls work?',
      inInbox: false,
      unread: true,
    });
  });

  it('follows a message id to its thread', async () => {
    const calls = gmail(
      notFound,
      () => json({ id: MESSAGE, threadId: THREAD }),
      () => json(gmailThread()),
      () => json({ labels: [] }),
    );
    const res = await open(MESSAGE);
    expect(res.ok && res.value.id).toBe(THREAD);
    expect(calls.map((c) => c.url).slice(0, 3)).toEqual([
      `/threads/${MESSAGE}?format=full`,
      `/messages/${MESSAGE}?format=minimal`,
      `/threads/${THREAD}?format=full`,
    ]);
  });

  it('says the email is not there when neither a thread nor a message has the id', async () => {
    gmail(notFound, notFound);
    const res = await open(MESSAGE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
    expect(res.error.message).toMatch(/^That email isn't in the mailbox/);
  });

  it('says Gmail is busy when it keeps rate-limiting past the deadline', async () => {
    gmail(() => json({ error: { code: 429 } }, 429, { 'retry-after': '60' }));
    const res = await open(THREAD);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('refuses a malformed id and a missing mailbox without asking Gmail', async () => {
    const calls = gmail();
    const bad = await open('../../settings');
    expect(!bad.ok && bad.error).toMatchObject({
      code: 'invalid_input',
      message: "That link doesn't point at an email.",
    });
    const none = await open(THREAD, NONE);
    expect(!none.ok && none.error.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });
});
