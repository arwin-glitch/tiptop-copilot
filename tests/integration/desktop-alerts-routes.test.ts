import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import {
  DESKTOP_AUTH_FAILURES_PER_MINUTE,
  DESKTOP_RATE_PER_MINUTE,
  handleDesktopAlerts,
} from '@/lib/desktop/alerts-endpoint';
import { setStoreForTesting } from '@/lib/runtime';
import { resetLimiters } from '@/lib/security/limits';
import { mintDesktopToken } from '@/lib/services/desktop-alerts';
import type { AuditEvent, ChatMessage } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';
import { proxy } from '@/proxy';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * The desktop alert routes through their handlers: /api/push/desktop (the
 * signed-in page turns a computer on or off) and /api/desktop/alerts (the
 * shell, with its token and no session), their brakes, and the proxy.
 */

let harness: Harness;
let signedIn: AuthContext | null;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () =>
    signedIn
      ? ok(signedIn)
      : { ok: false, error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
}));

const desktopRoute = await import('@/app/api/push/desktop/route');
const alertsRoute = await import('@/app/api/desktop/alerts/route');

const ORIGIN = 'https://copilot.example';
// 15:00 UTC = 10:00 in Chicago (daylight time).
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_RE = /^tcdsk_[0-9a-f]{32}_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;
const TURN_ON = { device: DEVICE, platform: 'mac', version: '0.4.0' };

let address = 0;
let ip: string;

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  signedIn = harness.auth;
  ip = `203.0.113.${++address}`;
});

afterEach(async () => {
  await harness.dispose();
});

function page(method: 'POST' | 'DELETE', body: unknown, origin = ORIGIN) {
  return new NextRequest(`${ORIGIN}/api/push/desktop`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function shell(
  method: 'GET' | 'POST' | 'DELETE',
  options: { token?: string | null; body?: string; from?: string; agent?: string } = {},
) {
  const headers: Record<string, string> = { 'x-forwarded-for': options.from ?? ip };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.agent) headers['user-agent'] = options.agent;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}/api/desktop/alerts`, { method, headers, body: options.body });
}

const at = () => NOON_ISH;

async function turnOn(): Promise<string> {
  const res = await desktopRoute.POST(page('POST', TURN_ON));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; token: string };
  return body.token;
}

describe('/api/push/desktop', () => {
  it('needs a session and this site', async () => {
    signedIn = null;
    expect((await desktopRoute.POST(page('POST', TURN_ON))).status).toBe(401);
    signedIn = harness.auth;
    expect((await desktopRoute.POST(page('POST', TURN_ON, 'https://evil.example'))).status).toBe(
      403,
    );
    expect((await desktopRoute.DELETE(page('DELETE', { device: DEVICE }, 'null'))).status).toBe(
      403,
    );
  });

  it('refuses a bad body: not hex, an app before 0.4.0, Linux', async () => {
    for (const body of [
      { ...TURN_ON, device: 'G'.repeat(32) },
      { ...TURN_ON, device: DEVICE.slice(1) },
      { ...TURN_ON, version: '0.3.9' },
      { ...TURN_ON, version: 'latest' },
      { ...TURN_ON, platform: 'linux' },
      null,
    ]) {
      expect((await desktopRoute.POST(page('POST', body))).status).toBe(400);
    }
  });

  it('answers the token once, never cached, and at most 10 times an hour', async () => {
    const res = await desktopRoute.POST(page('POST', TURN_ON));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { token: string }).token).toMatch(TOKEN_RE);
    for (let i = 2; i <= 10; i++) {
      expect((await desktopRoute.POST(page('POST', TURN_ON))).status).toBe(200);
    }
    expect((await desktopRoute.POST(page('POST', TURN_ON))).status).toBe(429);
  });

  it('says whether Copilot still has a computer on, to a session only', async () => {
    const check = (device: string) =>
      desktopRoute.GET(new NextRequest(`${ORIGIN}/api/push/desktop?device=${device}`));
    signedIn = null;
    expect((await check(DEVICE)).status).toBe(401);
    signedIn = harness.auth;
    expect((await check('nope')).status).toBe(400);
    expect(await (await check(DEVICE)).json()).toEqual({ ok: true, on: false });
    await turnOn();
    const res = await check(DEVICE);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, on: true });
  });

  it('turns a computer off for whoever turned it on, or an admin', async () => {
    await turnOn();
    signedIn = { ...harness.auth, userId: '00000000-0000-4000-8000-0000000c0b01', role: 'member' };
    const refused = await desktopRoute.DELETE(page('DELETE', { device: DEVICE }));
    expect(refused.status).toBe(403);
    signedIn = harness.auth;
    const res = await desktopRoute.DELETE(page('DELETE', { device: DEVICE }));
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect(await (await desktopRoute.DELETE(page('DELETE', { device: DEVICE }))).json()).toEqual({
      ok: true,
      removed: 0,
    });
    expect((await desktopRoute.DELETE(page('DELETE', { device: 'nope' }))).status).toBe(400);
  });
});

describe('/api/desktop/alerts', () => {
  it('answers 401 with its realm to no token or a bad one', async () => {
    const none = await alertsRoute.GET(shell('GET'));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="tiptop-copilot"');
    const bad = await alertsRoute.GET(shell('GET', { token: 'tcdsk_nope' }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toBe(
      'Bearer realm="tiptop-copilot", error="invalid_token"',
    );
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });

  it('gives a computer its alerts and when to ask again', async () => {
    const token = await turnOn();
    const res = await alertsRoute.GET(shell('GET', { token }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      ok: boolean;
      alerts: unknown[];
      pollAfterSeconds: number;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.pollAfterSeconds).toBeGreaterThanOrEqual(60);

    const noon = (await (await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).json()) as {
      alerts: { keys: string[]; title: string; body: string; url: string; urgent: boolean }[];
      pollAfterSeconds: number;
    };
    expect(noon.pollAfterSeconds).toBe(60);
    expect(noon.alerts.length).toBeGreaterThan(0);
    for (const alert of noon.alerts) {
      expect(Object.keys(alert).sort()).toEqual([
        'body',
        'keys',
        'quietWhenFocused',
        'title',
        'urgent',
        'url',
      ]);
    }
  });

  it('records what the computer showed, and does not offer it again', async () => {
    const token = await turnOn();
    const first = (await (
      await handleDesktopAlerts(shell('GET', { token }), 'GET', at)
    ).json()) as {
      alerts: { keys: string[] }[];
    };
    const keys = first.alerts.flatMap((a) => a.keys);
    expect(keys.length).toBeGreaterThan(0);
    const posted = await handleDesktopAlerts(
      shell('POST', { token, body: JSON.stringify({ delivered: [...keys, 'evil:x'] }) }),
      'POST',
      at,
    );
    expect(await posted.json()).toEqual({ ok: true, recorded: keys.length });
    const again = (await (
      await handleDesktopAlerts(shell('GET', { token }), 'GET', at)
    ).json()) as {
      alerts: { keys: string[] }[];
    };
    for (const key of again.alerts.flatMap((a) => a.keys)) expect(keys).not.toContain(key);

    for (const body of ['not json', '{"delivered":"x"}', JSON.stringify({ delivered: [''] })]) {
      expect((await handleDesktopAlerts(shell('POST', { token, body }), 'POST', at)).status).toBe(
        400,
      );
    }
    const huge = JSON.stringify({ delivered: ['a'.repeat(70 * 1024)] });
    expect(
      (await handleDesktopAlerts(shell('POST', { token, body: huge }), 'POST', at)).status,
    ).toBe(413);
  });

  it('Ask Arwin answers reach a 0.4.1 shell only', async () => {
    const token = await turnOn();
    // The route turns the computer on by the real clock, so the answer lands after it.
    const at = new Date().toISOString();
    const threadId = '00000000-0000-4000-8000-00000000a001';
    const answerId = '00000000-0000-4000-8000-00000000b001';
    const { organizationId, userId } = harness.auth;
    await harness.store.insert('chat_threads', {
      id: threadId,
      organization_id: organizationId,
      user_id: userId,
      title: 'A fictional question',
      deal_id: null,
      created_at: at,
      updated_at: at,
    });
    const row = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
      id,
      organization_id: organizationId,
      thread_id: threadId,
      role,
      content,
      citations: [],
      tool_calls: [],
      model: null,
      prompt_version: null,
      status: 'answered',
      created_at: at,
    });
    await harness.store.insertMany('chat_messages', [
      row('00000000-0000-4000-8000-00000000c001', 'user', 'Who leads the fictional round?'),
      row(answerId, 'assistant', 'Fictional Capital leads it.'),
    ]);

    const ask = async (agent?: string) => {
      const res = await handleDesktopAlerts(shell('GET', { token, agent }), 'GET');
      const body = (await res.json()) as {
        alerts: { keys: string[]; quietWhenFocused: boolean }[];
      };
      return body.alerts.filter((a) => a.keys.some((k) => k.startsWith('ask:')));
    };
    expect(await ask()).toEqual([]);
    expect(await ask('TipTopCopilot/0.4.0 desktop-alerts')).toEqual([]);
    expect(await ask('TipTopCopilot/0.4.1 desktop-alerts')).toMatchObject([
      { keys: [`ask:${answerId}`], quietWhenFocused: true },
    ]);
  });

  it('turns itself off: the token stops working', async () => {
    const token = await turnOn();
    const res = await alertsRoute.DELETE(shell('DELETE', { token }));
    expect(await res.json()).toEqual({ ok: true });
    const after = await alertsRoute.GET(shell('GET', { token }));
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain('realm="tiptop-copilot"');
    const disabled = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'push.desktop_disabled' },
    })) as AuditEvent[];
    expect(disabled.map((r) => r.metadata)).toEqual([{ reason: 'app' }]);
  });

  it(`allows ${DESKTOP_RATE_PER_MINUTE} requests a minute per computer`, async () => {
    const token = await turnOn();
    for (let i = 0; i < DESKTOP_RATE_PER_MINUTE; i++) {
      expect((await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).status).toBe(200);
    }
    const limited = await handleDesktopAlerts(shell('GET', { token }), 'GET', at);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('bad tokens with a computer’s id do not use up that computer’s minute', async () => {
    const token = await turnOn();
    for (let i = 0; i < 25; i++) {
      const forged = mintDesktopToken(harness.auth.organizationId, DEVICE);
      const res = await handleDesktopAlerts(
        shell('GET', { token: forged, from: `198.51.100.${i}` }),
        'GET',
        at,
      );
      expect(res.status).toBe(401);
    }
    expect((await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).status).toBe(200);
  });

  it('the same computer id turned on in another organization uses up nothing of this one', async () => {
    const token = await turnOn();
    // Anyone can turn on any id in an organization of their own.
    signedIn = await addSecondOrganization(harness);
    const elsewhere = await turnOn();
    expect(elsewhere).not.toBe(token);
    for (let i = 0; i < 25; i++) {
      await handleDesktopAlerts(shell('GET', { token: elsewhere }), 'GET', at);
    }
    expect((await handleDesktopAlerts(shell('GET', { token: elsewhere }), 'GET', at)).status).toBe(
      429,
    );
    expect((await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).status).toBe(200);

    // Nor of this computer's ledger rows for the day.
    resetLimiters();
    for (let batch = 0; batch < 2; batch++) {
      const delivered = Array.from({ length: 200 }, (_, n) => `wait:other-${batch}-${n}`);
      await handleDesktopAlerts(
        shell('POST', { token: elsewhere, body: JSON.stringify({ delivered }) }),
        'POST',
        at,
      );
    }
    const posted = await handleDesktopAlerts(
      shell('POST', { token, body: JSON.stringify({ delivered: ['money:fictional-wire'] }) }),
      'POST',
      at,
    );
    expect(await posted.json()).toEqual({ ok: true, recorded: 1 });
  });

  it('brakes an address sending bad tokens, never a good token from it', async () => {
    const token = await turnOn();
    for (let i = 0; i < DESKTOP_AUTH_FAILURES_PER_MINUTE; i++) {
      expect((await handleDesktopAlerts(shell('GET', { token: 'junk' }), 'GET', at)).status).toBe(
        401,
      );
    }
    const braked = await handleDesktopAlerts(shell('GET', { token: 'junk' }), 'GET', at);
    expect(braked.status).toBe(429);
    expect(Number(braked.headers.get('retry-after'))).toBeGreaterThan(0);
    const forged = mintDesktopToken(harness.auth.organizationId, DEVICE);
    expect((await handleDesktopAlerts(shell('GET', { token: forged }), 'GET', at)).status).toBe(
      429,
    );
    expect((await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).status).toBe(200);
  });

  it('answers 503, never 401, when the store fails, and the computer stays', async () => {
    const token = await turnOn();
    const store = harness.store;
    setStoreForTesting(
      new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'membershipsForUser') return async () => Promise.reject(new Error('down'));
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    const res = await handleDesktopAlerts(shell('GET', { token }), 'GET', at);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('www-authenticate')).toBeNull();
    setStoreForTesting(store);
    expect((await handleDesktopAlerts(shell('GET', { token }), 'GET', at)).status).toBe(200);
  });
});

describe('the proxy', () => {
  it('lets the shell reach /api/desktop/alerts with no session, and nothing else new', async () => {
    const status = async (path: string) =>
      (await proxy(new NextRequest(`${ORIGIN}${path}`))).status;
    expect(await status('/api/desktop/alerts')).toBe(200);
    expect(await status('/api/push/desktop')).toBe(401);
    expect(await status('/api/desktop/alerts-admin')).toBe(401);
    expect(await status('/api/desktop/updates')).toBe(401);
  });
});
