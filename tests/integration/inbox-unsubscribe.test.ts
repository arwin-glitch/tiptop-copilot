import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS } from '@/lib/demo/ids';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';

/**
 * One-click unsubscribe: the address posted to comes from the message's
 * own headers on Gmail (stubbed here), must be https on a public host, and
 * the body is exactly RFC 8058's. Redirects are not followed.
 */

let headers = { from: '', listUnsubscribe: '', listUnsubscribePost: '' };
vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
  readUnsubscribeHeaders: async () => ok(headers),
}));

const { oneClickUnsubscribe } = await import('@/lib/services/inbox-unsubscribe');

const integration = (scopes: string[]): Integration => ({
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

const store = {} as never;
const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response('', { status: 200 }));
const publicHost = async () => true;

beforeEach(() => {
  fetchImpl.mockClear();
  headers = {
    from: 'News <news@letters.example>',
    listUnsubscribe: '<https://letters.example/u/abc>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
  };
});

describe('one-click unsubscribe', () => {
  it('posts RFC 8058 body to the header address, no redirects followed', async () => {
    const res = await oneClickUnsubscribe(
      store,
      false,
      integration([...SEND_SCOPES]),
      '18c0a1b2c3d4e5f6',
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        hostCheck: publicHost,
      },
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://letters.example/u/abc');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('List-Unsubscribe=One-Click');
    expect(init.redirect).toBe('manual');
  });

  it('refuses without one-click, on a private host, without sending on, and never in the demo', async () => {
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, hostCheck: publicHost };
    headers.listUnsubscribePost = '';
    expect(
      (
        await oneClickUnsubscribe(
          store,
          false,
          integration([...SEND_SCOPES]),
          '18c0a1b2c3d4e5f6',
          deps,
        )
      ).ok,
    ).toBe(false);
    headers.listUnsubscribePost = 'List-Unsubscribe=One-Click';
    expect(
      (
        await oneClickUnsubscribe(store, false, integration([...SEND_SCOPES]), '18c0a1b2c3d4e5f6', {
          ...deps,
          hostCheck: async () => false,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await oneClickUnsubscribe(store, false, integration([]), '18c0a1b2c3d4e5f6', deps)).ok,
    ).toBe(false);
    expect((await oneClickUnsubscribe(store, true, null, '18c0a1b2c3d4e5f6', deps)).ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
