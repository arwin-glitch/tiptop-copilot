import { iosAppVersion } from './shared';

/**
 * The few things the page asks the iPhone app's shell to do, through the two
 * plugins it ships (ios-app/package.json): Push Notifications (permission,
 * registering with Apple's push service, and a tap on an alert) and App (the
 * sign-in return link).
 *
 * There is no `@capacitor/core` here. The shell itself defines
 * `window.Capacitor.Plugins.<name>` in every page it loads, a stub per
 * installed plugin whose methods call `Capacitor.nativePromise` and whose
 * `addListener` calls `Capacitor.addListener` (Capacitor 8.5.3, JSExport.swift
 * and native-bridge.js): exactly what the npm package would call. Looked up at
 * call time.
 *
 * Client-only, and every call is a no-op outside the app. A refused or
 * failed call resolves to null, because nothing here may throw into React.
 */

interface PluginStub {
  [method: string]: unknown;
  addListener?: (event: string, callback: (data: unknown) => void) => unknown;
}

interface CapacitorGlobal {
  getPlatform?: () => string;
  Plugins?: Record<string, PluginStub | undefined>;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap || typeof cap !== 'object') return null;
  return typeof cap.getPlatform === 'function' && cap.getPlatform() === 'ios' ? cap : null;
}

function plugin(name: string): PluginStub | null {
  return capacitor()?.Plugins?.[name] ?? null;
}

/** Whether this page is inside the iPhone app with its native bridge (both checks). */
export function inIosApp(): boolean {
  return iosAppVersion() !== null && capacitor() !== null;
}

/** Whether the shell has this plugin. */
export function hasIosPlugin(name: 'PushNotifications' | 'App'): boolean {
  return inIosApp() && plugin(name) !== null;
}

async function call(name: string, method: string, options: object = {}): Promise<unknown> {
  if (!inIosApp()) return null;
  const fn = plugin(name)?.[method];
  if (typeof fn !== 'function') return null;
  try {
    return await (fn as (options: object) => Promise<unknown>)(options);
  } catch {
    return null;
  }
}

/**
 * Follow a shell event; returns the unsubscribe, or null outside the app.
 * Both events used here are held by the shell until a listener is added, so
 * a tap or link that launched the app still arrives.
 */
export function onIosEvent(
  name: 'PushNotifications' | 'App',
  event: string,
  callback: (data: unknown) => void,
): (() => void) | null {
  if (!inIosApp()) return null;
  const add = plugin(name)?.addListener;
  if (typeof add !== 'function') return null;
  try {
    const handle = add(event, callback) as { remove?: () => unknown } | undefined;
    return () => {
      try {
        void handle?.remove?.();
      } catch {
        // Already gone with the page.
      }
    };
  } catch {
    return null;
  }
}

export type IosPermission = 'granted' | 'denied' | 'prompt';

function permission(value: unknown): IosPermission | null {
  const receive = (value as { receive?: unknown } | null)?.receive;
  return receive === 'granted' || receive === 'denied' || receive === 'prompt' ? receive : null;
}

/** Whether alerts are allowed for the app, or null outside it. Never asks. */
export async function iosAlertPermission(): Promise<IosPermission | null> {
  return permission(await call('PushNotifications', 'checkPermissions'));
}

/** Ask iOS to allow alerts (its own prompt, shown once); null outside the app. */
export async function requestIosAlertPermission(): Promise<IosPermission | null> {
  return permission(await call('PushNotifications', 'requestPermissions'));
}

/**
 * This iPhone's push token, lower case: registers with Apple's push service
 * and waits for the shell's answer (`registration`, or `registrationError`).
 * Null outside the app, on an error, or after `timeoutMs`. Asking again is
 * how a changed token is noticed; Apple says to register on every launch.
 */
export async function iosPushToken(timeoutMs = 15_000): Promise<string | null> {
  if (!hasIosPlugin('PushNotifications')) return null;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const offs: ((() => void) | null)[] = [];
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      for (const off of offs) off?.();
      resolve(token);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    offs.push(
      onIosEvent('PushNotifications', 'registration', (data) => {
        const value = (data as { value?: unknown } | null)?.value;
        finish(
          typeof value === 'string' && /^[0-9a-f]{64,200}$/i.test(value)
            ? value.toLowerCase()
            : null,
        );
      }),
      onIosEvent('PushNotifications', 'registrationError', () => finish(null)),
    );
    void call('PushNotifications', 'register').then((done) => {
      // A refused call never gets an answer: stop waiting at once.
      if (done === null && !settled) finish(null);
    });
  });
}

/** The app's build number (CFBundleVersion), or null when the App plugin is missing. */
export async function iosAppBuild(): Promise<string | null> {
  const info = (await call('App', 'getInfo')) as { build?: unknown } | null;
  const build = info?.build;
  return typeof build === 'string' && /^[0-9][0-9.]{0,31}$/.test(build) ? build : null;
}
