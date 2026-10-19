import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IN_EVERY_MS, checkInIosAlerts, turnOnIosAlerts } from '@/lib/ios/alerts-client';

/**
 * The iPhone app checking in for alerts on launch and resume
 * (lib/ios/alerts-client.ts), against a stand-in for the shell's plugins and
 * for Copilot's /api/push/ios: it refreshes only when due, follows a changed
 * token, turns itself off when notifications were switched off in iOS
 * Settings (and on again when they come back), and never brings back an
 * iPhone that was turned off elsewhere. Fictional tokens only.
 */

const APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TipTopCopilotiOS/1.0.0';
const TOKEN_A = 'A1'.repeat(32);
const TOKEN_B = 'B2'.repeat(32);
const key = (token: string) =>
  createHash('sha256').update(token.toLowerCase()).digest('hex').slice(0, 40);

interface Shell {
  permission: 'granted' | 'denied' | 'prompt';
  token: string;
  calls: string[];
}

interface Server {
  devices: Map<string, { mine: boolean }>;
  requests: { method: string; url: string; body: Record<string, unknown> | null }[];
}

let shell: Shell;
let server: Server;
let storage: Map<string, string>;
const T0 = Date.parse('2026-10-19T15:00:00Z');

function install() {
  storage = new Map();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const plugin = (name: string, methods: Record<string, () => Promise<unknown>>) => ({
    addListener: (event: string, callback: (data: unknown) => void) => {
      const id = `${name}:${event}`;
      listeners.set(id, [...(listeners.get(id) ?? []), callback]);
      return {
        remove: () =>
          listeners.set(
            id,
            (listeners.get(id) ?? []).filter((l) => l !== callback),
          ),
      };
    },
    ...methods,
  });
  const fire = (id: string, data: unknown) => {
    for (const listener of listeners.get(id) ?? []) listener(data);
  };
  vi.stubGlobal('navigator', { userAgent: APP_UA });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    Capacitor: {
      getPlatform: () => 'ios',
      Plugins: {
        PushNotifications: plugin('PushNotifications', {
          checkPermissions: async () => {
            shell.calls.push('checkPermissions');
            return { receive: shell.permission };
          },
          requestPermissions: async () => {
            shell.calls.push('requestPermissions');
            if (shell.permission === 'prompt') shell.permission = 'granted';
            return { receive: shell.permission };
          },
          register: async () => {
            shell.calls.push('register');
            setTimeout(() => fire('PushNotifications:registration', { value: shell.token }));
            return undefined;
          },
        }),
        App: plugin('App', { getInfo: async () => ({ build: '7.1', version: '1.0.0' }) }),
      },
    },
  });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    server.requests.push({ method, url: input, body });
    if (method === 'GET') {
      const k = new URL(input, 'https://copilot.example').searchParams.get('key') ?? '';
      const device = server.devices.get(k);
      return Response.json({
        ok: true,
        on: Boolean(device),
        mine: device?.mine ?? false,
        buildAgeDays: device ? 3 : null,
      });
    }
    if (method === 'POST') {
      const k = key(String(body?.token));
      if (typeof body?.replaces === 'string') server.devices.delete(body.replaces);
      server.devices.set(k, { mine: true });
      return Response.json({ ok: true, key: k });
    }
    server.devices.delete(String(body?.key));
    return Response.json({ ok: true, removed: 1 });
  });
}

const methods = () => server.requests.map((r) => r.method);

beforeEach(() => {
  shell = { permission: 'granted', token: TOKEN_A, calls: [] };
  server = { devices: new Map(), requests: [] };
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checking in on launch', () => {
  it('asks nothing while permission was never asked for', async () => {
    shell.permission = 'prompt';
    await checkInIosAlerts(T0);
    expect(shell.calls).toEqual(['checkPermissions']);
    expect(server.requests).toEqual([]);
  });

  it('with no record: checks in only if Copilot has this iPhone on, then waits 12 hours', async () => {
    server.devices.set(key(TOKEN_A), { mine: true });
    await checkInIosAlerts(T0);
    expect(methods()).toEqual(['GET', 'POST']);
    expect(server.requests[1]?.body).toMatchObject({
      token: TOKEN_A.toLowerCase(),
      version: '1.0.0',
      build: '7.1',
      replaces: null,
    });

    server.requests = [];
    shell.calls = [];
    await checkInIosAlerts(T0 + CHECK_IN_EVERY_MS - 1);
    expect(server.requests).toEqual([]);
    expect(shell.calls).toEqual(['checkPermissions']);

    await checkInIosAlerts(T0 + CHECK_IN_EVERY_MS);
    expect(methods()).toEqual(['GET', 'POST']);
  });

  it('never turns on an iPhone Copilot does not have on', async () => {
    await checkInIosAlerts(T0);
    expect(methods()).toEqual(['GET']);
    server.requests = [];
    shell.calls = [];
    await checkInIosAlerts(T0 + 2 * CHECK_IN_EVERY_MS);
    expect(server.requests).toEqual([]);
    expect(shell.calls).toEqual(['checkPermissions']);
  });

  it('follows a changed token, replacing the old one', async () => {
    shell.permission = 'prompt';
    expect((await turnOnIosAlerts()).state).toEqual({ kind: 'on', buildAgeDays: 0 });
    server.requests = [];
    shell.token = TOKEN_B;
    await checkInIosAlerts(Date.now() + CHECK_IN_EVERY_MS);
    expect(methods()).toEqual(['GET', 'POST']);
    expect(server.requests[0]?.url).toContain(key(TOKEN_A));
    expect(server.requests[1]?.body).toMatchObject({ replaces: key(TOKEN_A) });
    expect([...server.devices.keys()]).toEqual([key(TOKEN_B)]);
  });

  it('turned off elsewhere stays off', async () => {
    shell.permission = 'prompt';
    await turnOnIosAlerts();
    server.devices.clear();
    server.requests = [];
    await checkInIosAlerts(Date.now() + CHECK_IN_EVERY_MS);
    expect(methods()).toEqual(['GET']);
    server.requests = [];
    await checkInIosAlerts(Date.now() + 3 * CHECK_IN_EVERY_MS);
    expect(server.requests).toEqual([]);
  });

  it('notifications switched off turn the iPhone off, and on again when they come back', async () => {
    shell.permission = 'prompt';
    await turnOnIosAlerts();
    server.requests = [];
    shell.permission = 'denied';
    await checkInIosAlerts(Date.now());
    expect(server.requests).toEqual([
      {
        method: 'DELETE',
        url: '/api/push/ios',
        body: { key: key(TOKEN_A), reason: 'permission' },
      },
    ]);
    // Asked once only.
    await checkInIosAlerts(Date.now());
    expect(methods()).toEqual(['DELETE']);

    server.requests = [];
    shell.permission = 'granted';
    await checkInIosAlerts(Date.now());
    expect(methods()).toEqual(['POST']);
    expect(server.devices.has(key(TOKEN_A))).toBe(true);
  });

  it('does nothing in Safari or the home-screen web app', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    });
    await checkInIosAlerts(T0);
    expect(shell.calls).toEqual([]);
    expect(server.requests).toEqual([]);
  });
});
