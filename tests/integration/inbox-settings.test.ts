import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { FILTER_SCOPES } from '@/lib/google/send-scopes';
import { resetDemoSettings } from '@/lib/services/inbox-settings';
import type { Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';
import { VACATION_OFF } from '@/lib/email/vacation';

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

const writeVacation = vi.fn(async (_s: unknown, _i: unknown, v: unknown) => ok(v));
const readVacation = vi.fn(async (..._args: unknown[]) => ok({ ...VACATION_OFF }));

vi.mock('@/lib/google/gmail-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-settings')>()),
  writeVacation: (s: unknown, i: unknown, v: unknown) => writeVacation(s, i, v),
  readVacation: (...args: unknown[]) => readVacation(...args),
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
const vacation = await import('@/app/api/inbox/vacation/route');

const postVacation = (body: unknown) =>
  vacation.POST(
    new NextRequest('http://localhost/api/inbox/vacation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const ON = {
  ...VACATION_OFF,
  enabled: true,
  subject: 'Out of office',
  html: 'Back on <b>Monday</b>.<img src="x" onerror="y()">',
  start: '2026-11-10T06:00:00.000Z',
  end: '2026-11-17T06:00:00.000Z',
};

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
  writeVacation.mockClear();
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

describe('vacation responder', () => {
  it('demo: turns on and off in memory, sanitized, without reaching Gmail', async () => {
    const before = await (await vacation.GET()).json();
    expect(before.access).toBe('demo');
    expect(before.vacation.enabled).toBe(false);
    const on = await postVacation(ON);
    expect(on.status).toBe(200);
    const saved = (await on.json()).vacation;
    expect(saved.enabled).toBe(true);
    expect(saved.html).toBe('Back on <b>Monday</b>.');
    expect((await (await vacation.GET()).json()).vacation.enabled).toBe(true);
    const off = await postVacation({ ...saved, enabled: false });
    expect((await off.json()).vacation.enabled).toBe(false);
    expect(writeVacation).not.toHaveBeenCalled();
  });

  it('refuses an empty or backwards responder, and unknown fields', async () => {
    expect((await postVacation({ ...ON, subject: '', html: '' })).status).toBe(400);
    expect((await postVacation({ ...ON, end: '2026-11-01T00:00:00.000Z' })).status).toBe(400);
    expect((await postVacation({ ...ON, forwardTo: 'someone@else.example' })).status).toBe(400);
  });

  it('live: needs the settings grant to read or write', async () => {
    live = true;
    const read = await (await vacation.GET()).json();
    expect(read.access).toBe('off');
    expect(read.vacation).toBeNull();
    expect((await postVacation(ON)).status).toBe(403);
    expect(writeVacation).not.toHaveBeenCalled();
    scopes = [...FILTER_SCOPES];
    expect((await postVacation(ON)).status).toBe(200);
    expect(writeVacation).toHaveBeenCalledTimes(1);
  });
});
