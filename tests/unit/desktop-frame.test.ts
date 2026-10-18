import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_BOOT_SCRIPT } from '@/lib/desktop/frame-boot';
import { hasNativeBridge, showAppMenu, windowControl, windowFrame } from '@/lib/desktop/native';
import { desktopFrame } from '@/lib/desktop/shared';
import { clampZoom, isWindows10, menuAnchor, nextToolbarIndex } from '@/lib/desktop/title-bar';

/**
 * The desktop app's top bar, from 0.3.0: the pre-paint script that turns it
 * on, the calls it makes to the shell, and the pure geometry and keyboard
 * rules. In a browser all of it must stay off and silent.
 */

interface Booted {
  attrs: Record<string, string>;
  props: Record<string, string>;
}

/** Runs the pre-paint script against fakes of window, document and localStorage. */
function boot(
  globals: Record<string, unknown>,
  storage: { getItem(key: string): string | null } = { getItem: () => null },
): Booted {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      style: {
        setProperty: (name: string, value: string) => {
          props[name] = value;
        },
      },
    },
  };
  new Function('window', 'document', 'localStorage', FRAME_BOOT_SCRIPT)(globals, document, storage);
  return { attrs, props };
}

describe('the pre-paint script', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks <html> exactly when desktopFrame() would draw the bar', () => {
    const frames = ['windows', 'mac', 'linux', '', undefined, 1];
    const versions = [
      '0.3.0',
      '0.3.7',
      '0.10.0',
      '1.0.0',
      '0.2.1',
      '0.2.99',
      '0.1.0',
      ' 0.3.0 ',
      'v0.3.0',
      '0.3',
      '0.3.0-beta',
      '99999.1.1',
      '',
      undefined,
      3,
    ];
    for (const frame of frames) {
      for (const version of versions) {
        const globals = { __TIPTOP_DESKTOP_FRAME__: frame, __TIPTOP_DESKTOP__: version };
        vi.stubGlobal('window', globals);
        const expected = desktopFrame();
        const { attrs } = boot(globals);
        expect(attrs['data-desktop-frame'] ?? null, `${String(frame)} ${String(version)}`).toBe(
          expected,
        );
      }
    }
  });

  it('applies the cached zoom only when it is a sensible level', () => {
    const globals = { __TIPTOP_DESKTOP_FRAME__: 'windows', __TIPTOP_DESKTOP__: '0.3.0' };
    expect(boot(globals, { getItem: () => '1.25' }).props['--desktop-zoom']).toBe('1.25');
    expect(boot(globals, { getItem: () => '0.5' }).props['--desktop-zoom']).toBe('0.5');
    for (const stored of ['abc', '9', '0', '-1', 'Infinity', null]) {
      expect(boot(globals, { getItem: () => stored }).props).toEqual({});
    }
  });

  it('shows "restore" from the first frame when the window was last maximised', () => {
    const globals = { __TIPTOP_DESKTOP_FRAME__: 'windows', __TIPTOP_DESKTOP__: '0.3.0' };
    const stored = (maximized: string | null) => ({
      getItem: (key: string) => (key === 'tiptop-desktop-maximized' ? maximized : null),
    });
    expect(boot(globals, stored('1')).attrs).toEqual({
      'data-desktop-frame': 'windows',
      'data-desktop-maximized': '',
    });
    for (const value of ['0', 'true', '', null]) {
      expect(boot(globals, stored(value)).attrs).toEqual({ 'data-desktop-frame': 'windows' });
    }
    // An older app, or a browser, never gets it.
    expect(
      boot({ __TIPTOP_DESKTOP_FRAME__: 'windows', __TIPTOP_DESKTOP__: '0.2.1' }, stored('1')).attrs,
    ).toEqual({});
  });

  it('never touches <html> outside the frameless app, even with a zoom stored', () => {
    const { attrs, props } = boot(
      { __TIPTOP_DESKTOP__: '0.2.1', __TIPTOP_DESKTOP_FRAME__: 'windows' },
      { getItem: () => '1.25' },
    );
    expect(attrs).toEqual({});
    expect(props).toEqual({});
    expect(boot({}).attrs).toEqual({});
  });

  it('survives storage that throws, keeping the frame', () => {
    const { attrs, props } = boot(
      { __TIPTOP_DESKTOP_FRAME__: 'mac', __TIPTOP_DESKTOP__: '0.3.0' },
      {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    );
    expect(attrs).toEqual({ 'data-desktop-frame': 'mac' });
    expect(props).toEqual({});
  });
});

describe('calls to the shell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withBridge(answer: (cmd: string, args: unknown) => Promise<unknown>) {
    const invoke = vi.fn(answer);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    return invoke;
  }

  it('do nothing outside the app', async () => {
    expect(hasNativeBridge()).toBe(false);
    expect(await windowFrame()).toBeNull();
    await expect(windowControl('close')).resolves.toBeUndefined();
    await expect(showAppMenu(6, 40)).resolves.toBeUndefined();

    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: 'not a function' } });
    expect(hasNativeBridge()).toBe(false);
    expect(await windowFrame()).toBeNull();
  });

  it('send exactly the command and arguments the shell expects', async () => {
    const invoke = withBridge(async (cmd) =>
      cmd === 'window_frame' ? { maximized: true, fullscreen: false, zoom: 1.25 } : null,
    );
    expect(hasNativeBridge()).toBe(true);
    await windowControl('minimize');
    await windowControl('toggle-maximize');
    await windowControl('close');
    await windowControl('exit-full-screen');
    await showAppMenu(6, 40);
    expect(await windowFrame()).toEqual({ maximized: true, fullscreen: false, zoom: 1.25 });
    expect(invoke.mock.calls).toEqual([
      ['window_control', { action: 'minimize' }],
      ['window_control', { action: 'toggle-maximize' }],
      ['window_control', { action: 'close' }],
      ['window_control', { action: 'exit-full-screen' }],
      ['show_app_menu', { x: 6, y: 40 }],
      ['window_frame', {}],
    ]);
  });

  it('read the window state strictly', async () => {
    const bad = [
      null,
      'yes',
      {},
      { maximized: 'true', fullscreen: false, zoom: 1 },
      { maximized: false, fullscreen: 0, zoom: 1 },
      { maximized: false, fullscreen: false },
      { maximized: false, fullscreen: false, zoom: '1' },
      { maximized: false, fullscreen: false, zoom: Number.NaN },
      { maximized: false, fullscreen: false, zoom: 0.1 },
      { maximized: false, fullscreen: false, zoom: 9 },
    ];
    for (const answer of bad) {
      withBridge(async () => answer);
      expect(await windowFrame(), JSON.stringify(answer)).toBeNull();
    }
  });

  it('never throw when the shell refuses', async () => {
    withBridge(async () => {
      throw new Error('not allowed');
    });
    expect(await windowFrame()).toBeNull();
    await expect(windowControl('minimize')).resolves.toBeUndefined();
    await expect(showAppMenu(6, 40)).resolves.toBeUndefined();

    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: () => {
          throw new Error('sync failure');
        },
      },
    });
    await expect(windowControl('close')).resolves.toBeUndefined();
  });

  it('never send a menu position that is not a number', async () => {
    const invoke = withBridge(async () => null);
    await showAppMenu(Number.NaN, 1);
    await showAppMenu(1, Number.POSITIVE_INFINITY);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the bar’s geometry and keys', () => {
  it('hangs the menu from the bar’s bottom edge, at the button’s left', () => {
    expect(menuAnchor({ left: 6 }, { bottom: 40 })).toEqual({ x: 6, y: 40 });
    expect(menuAnchor({ left: 4.8 }, { bottom: 32.4 })).toEqual({ x: 5, y: 32 });
    expect(menuAnchor({ left: -3 }, { bottom: -1 })).toEqual({ x: 0, y: 0 });
  });

  it('moves along the toolbar with the arrows, wrapping and skipping what is off', () => {
    const all = [true, true, true, true];
    expect(nextToolbarIndex(0, 'ArrowRight', all)).toBe(1);
    expect(nextToolbarIndex(3, 'ArrowRight', all)).toBe(0);
    expect(nextToolbarIndex(0, 'ArrowLeft', all)).toBe(3);
    // Back (or Forward) disabled at either end of the history.
    expect(nextToolbarIndex(0, 'ArrowRight', [true, false, true, true])).toBe(2);
    expect(nextToolbarIndex(2, 'ArrowLeft', [false, false, true, true])).toBe(3);
    expect(nextToolbarIndex(1, 'Home', [false, true, true, false])).toBe(1);
    expect(nextToolbarIndex(1, 'End', [false, true, true, false])).toBe(2);
    expect(nextToolbarIndex(2, 'Enter', all)).toBe(2);
    expect(nextToolbarIndex(2, 'ArrowRight', [false, false, false, false])).toBe(2);
    expect(nextToolbarIndex(0, 'ArrowRight', [])).toBe(0);
  });

  it('tells Windows 10 from Windows 11 by the platform version hint', () => {
    for (const version of ['10.0.0', '7.0.0', '8.0.0', '12.9.0', '0.3.0']) {
      expect(isWindows10('Windows', version), version).toBe(true);
    }
    for (const version of ['13.0.0', '14.0.0', '15.0.0', '', 'abc', '10.x', undefined, null, 10]) {
      expect(isWindows10('Windows', version), String(version)).toBe(false);
    }
    // Another system's version means nothing here (Linux reports its kernel's).
    for (const platform of ['Linux', 'macOS', '', undefined]) {
      expect(isWindows10(platform, '10.0.0'), String(platform)).toBe(false);
    }
  });

  it('reads a zoom level as 100% unless it is a sensible number', () => {
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(0.5)).toBe(0.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.1, 9, '1.25', null]) {
      expect(clampZoom(value)).toBe(1);
    }
  });
});
