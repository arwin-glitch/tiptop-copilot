import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { FILTER_SCOPES } from '@/lib/google/send-scopes';
import { resetDemoSettings } from '@/lib/services/inbox-settings';
import type { Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';

/**
 * The Inbox's Gmail settings routes. The demo keeps them in memory; against
 * Gmail the settings module is stubbed (no network), so the test sees exactly
 * what would be written, and that nothing is written without the grant.
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

const readSignature = vi.fn(async (..._args: unknown[]) =>
  ok({ email: 'partner@firm.example', html: 'Old' }),
);
const writeSignature = vi.fn(async (_s: unknown, _i: unknown, html: string) =>
  ok({ email: 'partner@firm.example', html }),
);

vi.mock('@/lib/google/gmail-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-settings')>()),
  readSignature: (...args: unknown[]) => readSignature(...args),
  writeSignature: (s: unknown, i: unknown, html: string) => writeSignature(s, i, html),
}));

vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION() : null,
  }),
}));

const signature = await import('@/app/api/inbox/signature/route');

const postSignature = (html: string) =>
  signature.POST(
    new NextRequest('http://localhost/api/inbox/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    }),
  );

beforeEach(async () => {
  live = false;
  scopes = [];
  readSignature.mockClear();
  writeSignature.mockClear();
  resetDemoSettings();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('signature', () => {
  it('demo: reads and saves a sanitized signature without reaching Gmail', async () => {
    const read = await (await signature.GET()).json();
    expect(read.access).toBe('demo');
    expect(read.html).toContain('Sam Rivera');
    const res = await postSignature('<b>Pat</b><script>alert(1)</script>');
    expect(res.status).toBe(200);
    expect((await res.json()).html).toBe('<b>Pat</b>');
    expect(writeSignature).not.toHaveBeenCalled();
  });

  it('live without the settings grant: reads, but refuses to save', async () => {
    live = true;
    const read = await (await signature.GET()).json();
    expect(read.access).toBe('off');
    expect(read.html).toBe('Old');
    const res = await postSignature('New');
    expect(res.status).toBe(403);
    expect(writeSignature).not.toHaveBeenCalled();
  });

  it('live with the grant: saves on the Save click', async () => {
    live = true;
    scopes = [...FILTER_SCOPES];
    const res = await postSignature('New');
    expect(res.status).toBe(200);
    expect(writeSignature).toHaveBeenCalledTimes(1);
    expect(writeSignature.mock.calls[0]![2]).toBe('New');
  });
});
