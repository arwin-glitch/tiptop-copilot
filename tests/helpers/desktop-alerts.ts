import type { Page } from '@playwright/test';

/**
 * The desktop app from 0.4.0, simulated for Playwright: the shell's globals
 * and a stand-in for its IPC that records every call and answers the five
 * desktop alert commands from `window.__alerts` (`{on, permission,
 * platform}`), with a made-up device id (FAKE_DEVICE unless a test picks
 * another). `alerts_turn_on` refuses a
 * token that is not shaped like one or names another device, as the shell
 * does. Calls and state live in sessionStorage, so they survive a reload.
 */

export const FAKE_DEVICE = 'c0ffee00c0ffee00c0ffee00c0ffee00';

export interface AlertsShellOptions {
  version?: string;
  /** This computer's id; FAKE_DEVICE unless a test needs one Copilot has never seen. */
  device?: string;
  /** The main window's frame flag; null for a second window. */
  frame?: 'windows' | 'mac' | null;
  state?: {
    on: boolean;
    permission: 'granted' | 'denied' | 'prompt' | 'unavailable';
    platform: 'mac' | 'windows';
  };
}

/** An init script: pass it to `page.addInitScript`. Self-contained, as Playwright requires. */
export function markAsAlertsDesktop({
  version = '0.4.0',
  device = 'c0ffee00c0ffee00c0ffee00c0ffee00',
  frame = 'windows',
  state = { on: false, permission: 'granted', platform: 'windows' },
}: AlertsShellOptions = {}) {
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
  Object.defineProperty(window, '__TIPTOP_DESKTOP__', { value: version });
  if (frame) Object.defineProperty(window, '__TIPTOP_DESKTOP_FRAME__', { value: frame });
  const calls = load<[string, Record<string, unknown>][]>('__shellCalls', []);
  const alerts = load<Record<string, unknown>>('__alertsState', { ...state });
  w.__shellCalls = calls;
  w.__alerts = alerts;
  const status = () => ({
    on: alerts.on,
    permission: alerts.permission,
    device,
    platform: alerts.platform,
  });
  const answer = (cmd: string, args: Record<string, unknown>): unknown => {
    switch (cmd) {
      case 'window_frame':
        return { maximized: false, fullscreen: false, zoom: 1 };
      case 'alerts_state':
        return status();
      case 'alerts_request_permission':
        if (alerts.permission === 'prompt') alerts.permission = 'granted';
        return status();
      case 'alerts_turn_on': {
        const match = /^tcdsk_[0-9a-f]{32}_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/.exec(
          String(args.token),
        );
        if (!match || match[1] !== device) throw new Error('refused');
        if (alerts.permission === 'granted') alerts.on = true;
        return status();
      }
      case 'alerts_turn_off':
        alerts.on = false;
        return status();
      case 'alerts_test':
        if (!alerts.on) throw new Error('refused');
        return status();
      default:
        return null;
    }
  };
  w.__TAURI_INTERNALS__ = {
    invoke(cmd: string, args?: Record<string, unknown>) {
      calls.push([cmd, args ?? {}]);
      save('__shellCalls', calls);
      try {
        const value = answer(cmd, args ?? {});
        save('__alertsState', alerts);
        return Promise.resolve(value);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    metadata: { currentWindow: { label: 'main' } },
  };
}

/** Every call the page made to the shell, oldest first. */
export function shellCalls(page: Page): Promise<[string, Record<string, unknown>][]> {
  return page.evaluate(
    () => (window as unknown as { __shellCalls: [string, Record<string, unknown>][] }).__shellCalls,
  );
}

/** The desktop alert commands the page called, in order. */
export async function alertCalls(page: Page): Promise<string[]> {
  return (await shellCalls(page)).map(([cmd]) => cmd).filter((cmd) => cmd.startsWith('alerts_'));
}
