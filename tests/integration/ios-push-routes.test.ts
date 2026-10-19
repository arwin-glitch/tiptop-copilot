import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import { iosDeviceKey, listIosDevices, registerIosDevice } from '@/lib/services/ios-push';
import { saveSubscription } from '@/lib/services/push-alerts';
import type { UserProfile } from '@/lib/types/domain';
import { err, ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The iPhone app's routes through their handlers: /api/push/ios (the app
 * turns alerts on, checks in, and off), /api/push/preference, /api/push/test,
 * the sender's /api/cron/push with iPhone tokens, the meeting link as JSON,
 * and the Google links that cannot finish inside the app. Fictional tokens.
 */

let harness: Harness;
let signedIn: AuthContext | null;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () =>
    signedIn
      ? ok(signedIn)
      : { ok: false, error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
  getAuthContext: async () => signedIn,
}));

let joinUrl: string | null = null;
vi.mock('@/lib/calendar/meetings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calendar/meetings')>()),
  readMeetingEvent: async () =>
    joinUrl ? ok({ joinUrl }) : err('not_found', 'That meeting is not on the calendar.'),
}));

const iosRoute = await import('@/app/api/push/ios/route');
const preferenceRoute = await import('@/app/api/push/preference/route');
const testRoute = await import('@/app/api/push/test/route');
const cronRoute = await import('@/app/api/cron/push/route');
const meetingRoute = await import('@/app/go/meeting/route');
const googleSignIn = await import('@/app/api/auth/google/route');
const googleConnect = await import('@/app/api/integrations/google/start/route');

const ORIGIN = 'https://copilot.example';
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const SECRET = 'cron-secret-for-tests-000000000000';
const SAVED = { ...process.env };
const APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TipTopCopilotiOS/1.0.0';
const SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

const token = (n: number) => createHash('sha256').update(`fictional-iphone-${n}`).digest('hex');
const IPHONE_WEB = {
  endpoint: 'https://web.push.apple.com/QFictionalIphoneEndpoint0002',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  signedIn = harness.auth;
  joinUrl = null;
  process.env.CRON_SECRET = SECRET;
  resetEnvCache();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

function page(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  { origin = ORIGIN, ua = APP_UA }: { origin?: string | null; ua?: string } = {},
) {
  const headers: Record<string, string> = { 'user-agent': ua };
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const TURN_ON = { token: token(1), version: '1.0.0', build: '7.1', builtDay: null };

async function colleague(role: 'member' | 'admin'): Promise<AuthContext> {
  const userId = `00000000-0000-4000-8000-0000000e0${role === 'admin' ? 'a' : 'b'}1`;
  const at = NOON_ISH.toISOString();
  const profile: UserProfile = {
    id: userId,
    email: `${role}@fund.example`,
    full_name: `Test ${role}`,
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: at,
    updated_at: at,
  };
  await harness.store.upsertUserProfile(profile);
  await harness.store.insert('organization_members', {
    id: `routes-${role}`,
    organization_id: harness.auth.organizationId,
    user_id: userId,
    role,
    created_at: at,
  });
  return { ...harness.auth, userId, role, profile };
}

describe('/api/push/ios', () => {
  it('needs a session, this site, and the iPhone app', async () => {
    signedIn = null;
    expect((await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON))).status).toBe(401);
    signedIn = harness.auth;
    expect(
      (
        await iosRoute.POST(
          page('/api/push/ios', 'POST', TURN_ON, { origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON, { ua: SAFARI_UA }))).status,
    ).toBe(400);
    expect(
      (
        await iosRoute.DELETE(
          page('/api/push/ios', 'DELETE', { key: '0'.repeat(40) }, { origin: 'null' }),
        )
      ).status,
    ).toBe(403);
    expect(await listIosDevices(harness.store, harness.auth.organizationId)).toEqual([]);
  });

  it('refuses a bad body: not a token, too short, an app before 1.0.0', async () => {
    for (const body of [
      { ...TURN_ON, token: 'a'.repeat(63) },
      { ...TURN_ON, token: `${'a'.repeat(63)}g` },
      { ...TURN_ON, version: '0.9.0' },
      { ...TURN_ON, version: 'latest' },
      { ...TURN_ON, build: 'seven' },
      { ...TURN_ON, builtDay: '19 Oct' },
      { ...TURN_ON, replaces: 'nope' },
      null,
    ]) {
      expect((await iosRoute.POST(page('/api/push/ios', 'POST', body))).status).toBe(400);
    }
  });

  it('turns an iPhone on, never cached, at most 10 times an hour, and answers its id only', async () => {
    const res = await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; key: string };
    expect(body).toEqual({ ok: true, key: iosDeviceKey(token(1)) });
    // An upper-case token, as the app's plugin reports it, is the same iPhone.
    const upper = { ...TURN_ON, token: token(1).toUpperCase() };
    for (let i = 2; i <= 10; i++) {
      expect((await iosRoute.POST(page('/api/push/ios', 'POST', upper))).status).toBe(200);
    }
    expect((await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON))).status).toBe(429);
    expect(await listIosDevices(harness.store, harness.auth.organizationId)).toHaveLength(1);
  });

  it('says whether it is on by the id, never by the token', async () => {
    await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON));
    const key = iosDeviceKey(token(1));
    const res = await iosRoute.GET(page(`/api/push/ios?key=${key}`, 'GET'));
    expect(await res.json()).toEqual({ ok: true, on: true, mine: true, buildAgeDays: 0 });
    expect((await iosRoute.GET(page(`/api/push/ios?key=${token(1)}`, 'GET'))).status).toBe(400);
    const off = await iosRoute.GET(page(`/api/push/ios?key=${'0'.repeat(40)}`, 'GET'));
    expect(await off.json()).toEqual({ ok: true, on: false, mine: false, buildAgeDays: null });
  });

  it('is turned off by whoever turned it on, or an admin', async () => {
    await iosRoute.POST(page('/api/push/ios', 'POST', TURN_ON));
    const key = iosDeviceKey(token(1));
    signedIn = await colleague('member');
    const refused = await iosRoute.DELETE(page('/api/push/ios', 'DELETE', { key }));
    expect(refused.status).toBe(403);
    signedIn = await colleague('admin');
    const res = await iosRoute.DELETE(page('/api/push/ios', 'DELETE', { key, reason: 'settings' }));
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect(await listIosDevices(harness.store, harness.auth.organizationId)).toEqual([]);
  });
});

describe('/api/push/preference and /api/push/test', () => {
  it('sets where your alerts go, from this site only', async () => {
    expect(
      (
        await preferenceRoute.POST(
          page('/api/push/preference', 'POST', { to: 'web' }, { origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await preferenceRoute.POST(page('/api/push/preference', 'POST', { to: 'phone' }))).status,
    ).toBe(400);
    const res = await preferenceRoute.POST(page('/api/push/preference', 'POST', { to: 'web' }));
    expect(await res.json()).toEqual({ ok: true, to: 'web' });
  });

  it('queues a test alert only for someone with a phone, three an hour', async () => {
    const none = await testRoute.POST(page('/api/push/test', 'POST'));
    expect(none.status).toBe(409);
    await registerIosDevice(harness.store, harness.auth, {
      token: token(1),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    expect((await testRoute.POST(page('/api/push/test', 'POST'))).status).toBe(200);
    expect((await testRoute.POST(page('/api/push/test', 'POST'))).status).toBe(200);
    expect((await testRoute.POST(page('/api/push/test', 'POST'))).status).toBe(429);
  });
});

describe('/api/cron/push with the iPhone app', () => {
  const cron = (path: string, init: { method?: string; body?: unknown } = {}) =>
    new NextRequest(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  it('lists tokens only to a sender that says it can reach Apple', async () => {
    await registerIosDevice(harness.store, harness.auth, {
      token: token(1),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    type Body = { outbox: { organizationId: string; apns: { key: string; token: string }[] }[] };
    const own = (body: Body) =>
      body.outbox.find((e) => e.organizationId === harness.auth.organizationId);
    const ready = (await (
      await cronRoute.GET(cron('/api/cron/push?scope=meetings&apns=1'))
    ).json()) as Body;
    expect(own(ready)?.apns.map((d) => d.token)).toEqual([token(1)]);
    const older = (await (
      await cronRoute.GET(cron('/api/cron/push?scope=meetings'))
    ).json()) as Body;
    expect(own(older)?.apns).toEqual([]);
  });

  it('holds the iPhone’s web push back unless the sender says APNs is failing (fallback=1)', async () => {
    const org = harness.auth.organizationId;
    await saveSubscription(harness.store, org, harness.auth.userId, IPHONE_WEB, 'ios');
    await registerIosDevice(harness.store, harness.auth, {
      token: token(1),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    type Body = {
      outbox: { organizationId: string; subscriptions: { endpoint: string }[]; apns: unknown[] }[];
    };
    const own = async (path: string) =>
      ((await (await cronRoute.GET(cron(path))).json()) as Body).outbox.find(
        (e) => e.organizationId === org,
      );
    const held = await own('/api/cron/push?scope=meetings&apns=1');
    expect(held?.subscriptions).toEqual([]);
    expect(held?.apns).toHaveLength(1);
    const failing = await own('/api/cron/push?scope=meetings&apns=1&fallback=1');
    expect(failing?.subscriptions.map((s) => s.endpoint)).toEqual([IPHONE_WEB.endpoint]);
    expect(failing?.apns).toHaveLength(1);
  });

  it('takes an older sender’s report, and drops the iPhones a newer one says are gone', async () => {
    const org = harness.auth.organizationId;
    const old = await cronRoute.POST(
      cron('/api/cron/push', {
        method: 'POST',
        body: { organizationId: org, sent: ['money:x'], gone: [] },
      }),
    );
    expect(await old.json()).toEqual({ ok: true, recorded: 1, removed: 0, removedIphones: 0 });

    await registerIosDevice(harness.store, harness.auth, {
      token: token(1),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    const key = iosDeviceKey(token(1));
    const bad = await cronRoute.POST(
      cron('/api/cron/push', {
        method: 'POST',
        body: { organizationId: org, sent: [], gone: [], goneApns: [{ key: token(1) }] },
      }),
    );
    expect(bad.status).toBe(400);
    const res = await cronRoute.POST(
      cron('/api/cron/push', {
        method: 'POST',
        body: {
          organizationId: org,
          sent: [],
          gone: [],
          // After the app last checked in (now), so it goes.
          goneApns: [{ key, at: Date.now() + 60_000 }],
        },
      }),
    );
    expect(await res.json()).toEqual({ ok: true, recorded: 0, removed: 0, removedIphones: 1 });
  });
});

describe('/go/meeting?format=json', () => {
  it('answers the join link for the iPhone app, or null for the Calendar tab', async () => {
    const get = (path: string) => meetingRoute.GET(page(path, 'GET'));
    joinUrl = 'https://zoom.us/j/1234567890';
    expect(await (await get('/go/meeting?id=evt-fictional&format=json')).json()).toEqual({
      ok: true,
      url: 'https://zoom.us/j/1234567890',
    });
    // The redirect is unchanged for everyone else.
    const redirect = await get('/go/meeting?id=evt-fictional');
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe('https://zoom.us/j/1234567890');

    joinUrl = 'https://evil.example/join';
    expect(await (await get('/go/meeting?id=evt-fictional&format=json')).json()).toEqual({
      ok: true,
      url: null,
    });
    expect(await (await get('/go/meeting?id=x&format=json')).json()).toEqual({
      ok: true,
      url: null,
    });
    signedIn = null;
    expect((await get('/go/meeting?id=evt-fictional&format=json')).status).toBe(401);
  });
});

describe('Google links inside the iPhone app', () => {
  it('answer with a page of their own instead of going to Google', async () => {
    for (const [handler, says, never] of [
      // Connecting Google is done on a computer.
      [
        () => googleConnect.GET(page('/api/integrations/google/start', 'GET')),
        'Do this on your computer',
        'Sign in with Google',
      ],
      // Signing in on a computer would not sign the app in: back to its own
      // sign-in page, which finishes in Safari.
      [
        () => googleSignIn.GET(page('/api/auth/google', 'GET')),
        'Go back and tap Sign in with Google',
        'on your computer',
      ],
    ] as const) {
      const res = await handler();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      expect(html).toContain(says);
      expect(html).not.toContain(never);
      expect(html).not.toContain('accounts.google.com');
    }
  });

  it('are untouched in Safari', async () => {
    const res = await googleSignIn.GET(
      page('/api/auth/google', 'GET', undefined, { ua: SAFARI_UA }),
    );
    expect(res.status).toBe(307);
    const connect = await googleConnect.GET(
      page('/api/integrations/google/start', 'GET', undefined, { ua: SAFARI_UA }),
    );
    expect(connect.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});
