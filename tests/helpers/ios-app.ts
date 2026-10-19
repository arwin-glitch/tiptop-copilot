import { writeFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * The iPhone app (ios-app/), simulated for Playwright: the 'ios' project runs
 * WebKit at an iPhone's size with the app's user agent (IOS_APP_UA), and
 * `markAsIosApp` stands in for what the Capacitor shell puts on every page:
 * `window.Capacitor` with getPlatform() 'ios' and the two plugins the app
 * ships, as Capacitor 8.5.3 defines them (Plugins.PushNotifications and
 * Plugins.App, with promise methods and addListener).
 *
 * Push permission and the token come from `window.__ios` (`{permission,
 * token}`); requestPermissions turns 'prompt' into `grantOnRequest`. A tap on
 * an alert or a link that opened the app can be waiting when the page loads
 * (`pendingTap`, `pendingUrl`), as the shell holds them until a listener is
 * added. Every call is recorded, and calls and state live in sessionStorage,
 * so they survive a reload. `window.__iosFire(plugin, event, data)` fires an
 * event from a test. All fictional.
 */

export const IOS_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TipTopCopilotiOS/1.0.0';
export const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
/** A made-up push token, upper case as the plugin reports it. */
export const FAKE_TOKEN = 'C0FFEE00'.repeat(8);

export interface IosShellOptions {
  permission?: 'granted' | 'denied' | 'prompt';
  grantOnRequest?: 'granted' | 'denied';
  token?: string;
  build?: string;
  pendingTap?: { actionId: string; url: string } | null;
  pendingUrl?: string | null;
}

/** An init script: pass it to `page.addInitScript`. Self-contained, as Playwright requires. */
export function markAsIosApp({
  permission = 'prompt',
  grantOnRequest = 'granted',
  token = 'C0FFEE00'.repeat(8),
  build = '7.1',
  pendingTap = null,
  pendingUrl = null,
}: IosShellOptions = {}) {
  const w = window as unknown as Record<string, unknown>;
  const load = <T>(key: string, fallback: T): T => {
    try {
      const saved = sessionStorage.getItem(key);
      return saved ? (JSON.parse(saved) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key: string, value: unknown) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Recording only.
    }
  };
  const calls = load<[string, string, unknown][]>('__iosCalls', []);
  const state = load<Record<string, unknown>>('__iosState', {
    permission,
    token,
    pendingTap,
    pendingUrl,
  });
  w.__iosCalls = calls;
  w.__ios = state;
  const record = (plugin: string, method: string, options: unknown) => {
    calls.push([plugin, method, options ?? {}]);
    save('__iosCalls', calls);
    save('__iosState', state);
  };
  const listeners: Record<string, ((data: unknown) => void)[]> = {};
  const fire = (plugin: string, event: string, data: unknown) => {
    for (const listener of listeners[`${plugin}:${event}`] ?? []) listener(data);
  };
  w.__iosFire = fire;
  const addListener = (plugin: string) => (event: string, callback: (data: unknown) => void) => {
    record(plugin, 'addListener', { eventName: event });
    const name = `${plugin}:${event}`;
    (listeners[name] ??= []).push(callback);
    // Held by the shell until something listens, then delivered once.
    if (name === 'PushNotifications:pushNotificationActionPerformed' && state.pendingTap) {
      const tap = state.pendingTap as { actionId: string; url: string };
      state.pendingTap = null;
      save('__iosState', state);
      setTimeout(() =>
        callback({ actionId: tap.actionId, notification: { data: { url: tap.url } } }),
      );
    }
    if (name === 'App:appUrlOpen' && state.pendingUrl) {
      const url = state.pendingUrl;
      state.pendingUrl = null;
      save('__iosState', state);
      setTimeout(() => callback({ url }));
    }
    return {
      remove: async () => {
        listeners[name] = (listeners[name] ?? []).filter((l) => l !== callback);
      },
    };
  };
  w.Capacitor = {
    getPlatform: () => 'ios',
    isNativePlatform: () => true,
    Plugins: {
      PushNotifications: {
        addListener: addListener('PushNotifications'),
        checkPermissions: async () => {
          record('PushNotifications', 'checkPermissions', {});
          return { receive: state.permission };
        },
        requestPermissions: async () => {
          record('PushNotifications', 'requestPermissions', {});
          if (state.permission === 'prompt') state.permission = grantOnRequest;
          save('__iosState', state);
          return { receive: state.permission };
        },
        register: async () => {
          record('PushNotifications', 'register', {});
          setTimeout(() => fire('PushNotifications', 'registration', { value: state.token }), 20);
          return undefined;
        },
      },
      App: {
        addListener: addListener('App'),
        getInfo: async () => {
          record('App', 'getInfo', {});
          return { name: 'TipTop Copilot', id: 'vc.tiptop.copilot', build, version: '1.0.0' };
        },
      },
    },
  };
}

/** Every call the page made to the shell, oldest first. */
export function iosCalls(page: Page): Promise<[string, string, Record<string, unknown>][]> {
  return page.evaluate(
    () =>
      (window as unknown as { __iosCalls: [string, string, Record<string, unknown>][] }).__iosCalls,
  );
}

/** Change the simulated shell's state (and keep it across a reload). */
export function setIosState(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate((next) => {
    const w = window as unknown as { __ios: Record<string, unknown> };
    Object.assign(w.__ios, next);
    sessionStorage.setItem('__iosState', JSON.stringify(w.__ios));
  }, patch);
}

/** Fire a shell event in the page, as the app would. */
export function fireIosEvent(page: Page, plugin: string, event: string, data: unknown) {
  return page.evaluate(
    ([p, e, d]) =>
      (window as unknown as { __iosFire: (p: string, e: string, d: unknown) => void }).__iosFire(
        p as string,
        e as string,
        d,
      ),
    [plugin, event, data] as const,
  );
}

/**
 * WebKit as Playwright builds it never sends a cookie marked Secure over
 * plain http, not even to localhost, and the e2e server is `next start`,
 * where every session and sign-in cookie is Secure. So in the 'ios' project
 * the attribute is dropped as cookies are set (on POSTs: the demo's Enter
 * button and the sign-in routes) and from a saved sign-in. The server only
 * ever checks a cookie's signed value, so nothing it decides changes.
 */
export async function dropSecureCookies(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch({ maxRedirects: 0 });
    const headers = response.headers();
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].replace(/;\s*secure/gi, '');
    }
    return route.fulfill({ response, headers });
  });
}

/** A saved sign-in with Secure dropped from its cookies (see dropSecureCookies). */
export async function saveSignedIn(context: BrowserContext, path: string): Promise<void> {
  const state = await context.storageState();
  state.cookies = state.cookies.map((cookie) => ({ ...cookie, secure: false }));
  await writeFile(path, JSON.stringify(state));
}
