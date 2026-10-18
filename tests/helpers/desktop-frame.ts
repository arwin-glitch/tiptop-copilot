import type { Page } from '@playwright/test';

/**
 * The desktop app's main window from 0.3.0, simulated for Playwright: both
 * shell globals, and a stand-in for the shell's IPC that records every call
 * and answers `window_frame` from `window.__frameState`, which a test may
 * change (then fire a `resize`, as maximising would).
 */

export interface FrameOptions {
  version?: string;
  frame?: 'windows' | 'mac';
  state?: { maximized: boolean; fullscreen: boolean; zoom: number };
}

/** An init script: pass it to `page.addInitScript` or `context.addInitScript`. */
export function markAsFramelessDesktop({
  version = '0.3.0',
  frame = 'windows',
  state = { maximized: false, fullscreen: false, zoom: 1 },
}: FrameOptions = {}) {
  const w = window as unknown as Record<string, unknown>;
  Object.defineProperty(window, '__TIPTOP_DESKTOP__', { value: version });
  Object.defineProperty(window, '__TIPTOP_DESKTOP_FRAME__', { value: frame });
  const calls: [string, unknown][] = [];
  w.__titlebarCalls = calls;
  w.__frameState = state;
  w.__TAURI_INTERNALS__ = {
    invoke(cmd: string, args?: unknown) {
      calls.push([cmd, args ?? {}]);
      return Promise.resolve(
        cmd === 'window_frame' ? { ...(w.__frameState as Record<string, unknown>) } : null,
      );
    },
    metadata: { currentWindow: { label: 'main' } },
  };
}

/** Every call the page made to the shell, oldest first. */
export function frameCalls(page: Page): Promise<[string, Record<string, unknown>][]> {
  return page.evaluate(
    () =>
      (window as unknown as { __titlebarCalls: [string, Record<string, unknown>][] })
        .__titlebarCalls,
  );
}

/** The calls other than the state reads, which come and go with every resize. */
export async function frameActions(page: Page): Promise<[string, Record<string, unknown>][]> {
  return (await frameCalls(page)).filter(([cmd]) => cmd !== 'window_frame');
}
