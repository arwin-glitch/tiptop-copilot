'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { openSearch, SEARCH_STATE_EVENT, type SearchState } from '@/components/shell/search-events';
import { DESKTOP_MAXIMIZED_KEY, DESKTOP_ZOOM_KEY } from '@/lib/desktop/frame-boot';
import {
  showAppMenu,
  windowControl,
  windowFrame,
  type WindowAction,
  type WindowFrameState,
} from '@/lib/desktop/native';
import { desktopFrame } from '@/lib/desktop/shared';
import { isWindows10, menuAnchor, nextToolbarIndex } from '@/lib/desktop/title-bar';
import { cn } from '@/lib/util/cn';
import {
  CloseGlyph,
  ExitFullScreenGlyph,
  MaximiseGlyph,
  MenuGlyph,
  MinimiseGlyph,
  RestoreGlyph,
} from './window-glyphs';

/**
 * The desktop app's top bar, Slack style: from 0.3.0 the main window has no
 * native title bar (Windows) or a transparent one (Mac), and this one bar
 * runs across the top in the emerald of what is under it (the rail, the
 * page-header band), so it reads as their top edge. On Windows it holds the
 * menu button (File, Edit and View, opened as a native menu by the shell),
 * Back and Forward, a "Search Kraken" field and the window controls; on a
 * Mac the traffic lights sit at its left, the menu stays in the menu bar at
 * the top of the screen, and the rest is the same.
 *
 * Rendered once, in the root layout, on every page. Its markup is always
 * there and CSS alone shows it, keyed to `html[data-desktop-frame]`, which
 * the pre-paint script sets in the main window of a 0.3.0 or newer app
 * (lib/desktop/frame-boot.ts). In a browser, an older app or a second window
 * it is never displayed and nothing else moves: every offset that makes room
 * for it adds `--titlebar-h`, which is 0px there.
 *
 * The empty parts of the bar move the window: CSS `app-region: drag` on
 * Windows (native drag, snap, double-click to maximise, right-click for the
 * window menu), and the shell's drag script, via `data-tauri-drag-region`,
 * on a Mac. Every control is `no-drag`. Nothing here takes focus with the
 * mouse, like native caption buttons, so Edit > Copy, Paste or Undo from the
 * menu act on the field the person was typing in.
 *
 * The shell opens the menu only when the person is asking for it, as
 * Windows itself reports, which a page cannot fake (desktop/src-tauri/src/
 * frame.rs): a click on the menu button, or a tap of Alt or F10 on its own.
 * So the button tells the shell about its press as it happens, while the
 * mouse button is still down, and asks for the menu on the click; the keys
 * ask as they go down. Like a native menu bar, the button is not a Tab stop,
 * and Alt or F10 is the keyboard's way in.
 */

type Item = 'back' | 'forward' | 'search';
/** The toolbar's Tab-reachable items in visual order: the roving tab stop walks these. */
const ITEMS: Item[] = ['back', 'forward', 'search'];

const noSubscribe = () => () => {};
const serverNull = () => null;
const serverFalse = () => false;

/** The Navigation API, which TypeScript's DOM types do not describe yet. */
interface NavigationLike extends EventTarget {
  canGoBack: boolean;
  canGoForward: boolean;
}

function navigationApi(): NavigationLike | null {
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  return nav && typeof nav.canGoBack === 'boolean' ? nav : null;
}

function subscribeHistory(onChange: () => void): () => void {
  const nav = navigationApi();
  if (!nav) return () => {};
  nav.addEventListener('currententrychange', onChange);
  return () => nav.removeEventListener('currententrychange', onChange);
}

// Without the Navigation API (WebKit before it shipped) both stay enabled: at
// either end of the history, Back or Forward simply does nothing.
const canGoBack = () => navigationApi()?.canGoBack ?? true;
const canGoForward = () => navigationApi()?.canGoForward ?? true;

/** Somewhere ⌘[ and ⌘] belong to the text, not to Back and Forward. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** Which toolbar item an event happened on, if any. */
function itemOf(target: EventTarget | null): Item | null {
  if (!(target instanceof Element)) return null;
  const key = target.closest('[data-titlebar-item]')?.getAttribute('data-titlebar-item');
  return ITEMS.find((item) => item === key) ?? null;
}

/** Mouse presses never move focus off the page, as with native caption buttons. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const AT_REST: WindowFrameState = { maximized: false, fullscreen: false, zoom: 1 };

/*
 * The window's state, as the shell last reported it: maximised (which
 * caption glyph), full screen (no dragging, no room kept for the traffic
 * lights) and zoom (the bar keeps its size). Null until the shell first
 * answers, which is what "ready" means below. Asked for again whenever it can
 * have changed: maximise, restore and zoom all resize the viewport, so this
 * needs no event permission from the shell.
 */
let windowState: WindowFrameState | null = null;
const windowListeners = new Set<() => void>();

async function refreshWindowState(): Promise<void> {
  const state = await windowFrame();
  if (!state) return;
  const root = document.documentElement;
  // On <html>, where --titlebar-h is worked out from it, so body padding,
  // sticky tops and overlays follow the zoom as well as the bar.
  root.style.setProperty('--desktop-zoom', String(state.zoom));
  // Which glyph the maximise button shows is CSS, keyed to this attribute,
  // which the pre-paint script also sets from the cache below: a window
  // that opens maximised shows "restore" from the first frame.
  root.toggleAttribute('data-desktop-maximized', state.maximized);
  try {
    window.localStorage.setItem(DESKTOP_ZOOM_KEY, String(state.zoom));
    window.localStorage.setItem(DESKTOP_MAXIMIZED_KEY, state.maximized ? '1' : '0');
  } catch {
    // Storage blocked: the next launch paints at 100% for a moment, then corrects.
  }
  const prev = windowState;
  if (
    prev &&
    prev.maximized === state.maximized &&
    prev.fullscreen === state.fullscreen &&
    prev.zoom === state.zoom
  ) {
    return;
  }
  windowState = state;
  for (const listener of windowListeners) listener();
}

function subscribeWindowState(onChange: () => void): () => void {
  // Outside the app's frameless window there is nothing to ask.
  if (!desktopFrame()) return () => {};
  windowListeners.add(onChange);
  let timer: number | undefined;
  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refreshWindowState(), 120);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refreshWindowState();
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisible);
  void refreshWindowState();
  return () => {
    windowListeners.delete(onChange);
    window.clearTimeout(timer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

const getWindowState = () => windowState;

export function DesktopTitleBar() {
  const frame = React.useSyncExternalStore(noSubscribe, desktopFrame, serverNull);
  const back = React.useSyncExternalStore(subscribeHistory, canGoBack, serverFalse);
  const forward = React.useSyncExternalStore(subscribeHistory, canGoForward, serverFalse);
  const reported = React.useSyncExternalStore(subscribeWindowState, getWindowState, serverNull);
  const pathname = usePathname();

  const win = reported ?? AT_REST;
  // The shell's safety-net strip (desktop/src-tauri/src/safety-strip.js)
  // steps aside only for a bar whose shell has answered.
  const ready = frame !== null && reported !== null;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuBusy = React.useRef(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  // The toolbar item someone last moved to; until then, the first one shown.
  const roving = React.useRef<Item | null>(null);

  // Windows only. With classic scrollbars the page's own scrollbar would sit
  // beside the close button; the shell turns on thin overlay ones, and
  // globals.css hides it while the pointer is on the bar.
  React.useEffect(() => {
    if (frame !== 'windows') return;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;';
    document.body.appendChild(probe);
    const overlay = probe.offsetWidth - probe.clientWidth === 0;
    probe.remove();
    if (overlay) document.documentElement.setAttribute('data-overlay-scrollbars', '');
  }, [frame]);

  // Windows 10 draws its caption buttons a little differently from Windows
  // 11 (a brighter close red, square corners; globals.css). The user agent
  // string says "Windows NT 10.0" on both; the client hints tell them apart.
  React.useEffect(() => {
    if (frame !== 'windows') return;
    let live = true;
    try {
      const hints = (
        navigator as Navigator & {
          userAgentData?: {
            getHighEntropyValues?(
              hints: string[],
            ): Promise<{ platform?: unknown; platformVersion?: unknown }>;
          };
        }
      ).userAgentData;
      hints
        ?.getHighEntropyValues?.(['platformVersion'])
        .then(({ platform, platformVersion }) => {
          if (live && isWindows10(platform, platformVersion)) {
            document.documentElement.setAttribute('data-win10', '');
          }
        })
        .catch(() => {});
    } catch {
      // No client hints: the Windows 11 look, which differs only in detail.
    }
    return () => {
      live = false;
    };
  }, [frame]);

  // The palette the Search field opened says when it is open: the field looks pressed meanwhile.
  React.useEffect(() => {
    if (!frame) return;
    const onState = (event: Event) =>
      setSearchOpen((event as CustomEvent<SearchState>).detail?.open === true);
    window.addEventListener(SEARCH_STATE_EVENT, onState);
    return () => window.removeEventListener(SEARCH_STATE_EVENT, onState);
  }, [frame]);

  /** A toolbar button, found in the DOM (they are tagged with data-titlebar-item). */
  const item = React.useCallback(
    (key: Item) =>
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-titlebar-item="${key}"]`) ?? null,
    [],
  );

  /** Where the menu hangs: from the bar's bottom edge, at the button's left. */
  const menuAt = React.useCallback(() => {
    const button = menuRef.current;
    const bar = rootRef.current;
    return button && bar
      ? menuAnchor(button.getBoundingClientRect(), bar.getBoundingClientRect())
      : null;
  }, []);

  const openMenu = React.useCallback(async () => {
    const at = menuAt();
    if (menuBusy.current || !at) return;
    menuBusy.current = true;
    setMenuOpen(true);
    try {
      // Resolves when the menu closes (it is modal), or at once when the
      // shell decides the person did not ask for it.
      await showAppMenu(at.x, at.y);
    } finally {
      menuBusy.current = false;
      setMenuOpen(false);
    }
  }, [menuAt]);

  // Alt on its own, or F10, opens the menu, as in Slack and every Windows app
  // with a menu bar. Asked as the key goes down, while the shell can still
  // see it held; the shell waits for it to be let go and opens the menu only
  // if nothing else was pressed with it. In the capture phase on `window`:
  // the Ask panel stops keys from bubbling past it. AltGr (Ctrl+Alt) never
  // counts.
  React.useEffect(() => {
    if (frame !== 'windows') return;
    let altAlone = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        if (event.repeat) return;
        altAlone = !event.ctrlKey && !event.shiftKey && !event.metaKey;
        if (altAlone) void openMenu();
        return;
      }
      altAlone = false;
      if (
        event.key === 'F10' &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        void openMenu();
      }
    };
    // Alt let go on its own: kept from WebView2 and Windows, which would
    // otherwise arm the window menu for the next key.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      if (altAlone && !event.ctrlKey) event.preventDefault();
      altAlone = false;
    };
    const reset = () => {
      altAlone = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, [frame, openMenu]);

  // A Mac's Back and Forward keys. Not on Windows, where WebView2 already
  // answers Alt+Left and Alt+Right: a handler here would go back twice.
  React.useEffect(() => {
    if (frame !== 'mac') return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || (event.key !== '[' && event.key !== ']')) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      if (event.key === '[') window.history.back();
      else window.history.forward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frame]);

  /** Which items can take the tab stop now: shown (this OS, this page) and enabled. */
  const enabledItems = React.useCallback(
    () =>
      ITEMS.map((key) => {
        const el = item(key);
        return el !== null && !el.disabled && el.getClientRects().length > 0;
      }),
    [item],
  );

  /**
   * One tab stop for the whole toolbar (WAI-ARIA roving tabindex): the item
   * last moved to while it is there, else the first item shown. Set on the
   * DOM, since which items show is only known after layout.
   */
  const placeTabStop = React.useCallback(() => {
    const enabled = enabledItems();
    let current = roving.current ? ITEMS.indexOf(roving.current) : -1;
    if (current < 0 || !enabled[current]) current = enabled.indexOf(true);
    ITEMS.forEach((key, index) => {
      const el = item(key);
      if (el) el.tabIndex = index === current ? 0 : -1;
    });
  }, [enabledItems, item]);

  // Search comes and goes with the app's pages, Back and Forward with the history.
  React.useEffect(() => {
    if (frame) placeTabStop();
  }, [frame, back, forward, pathname, placeTabStop]);

  // Arrows, Home and End move along the toolbar; focus arriving on an item
  // (by Tab, or an arrow) makes it the tab stop.
  const onToolbarKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = nextToolbarIndex(
      ITEMS.indexOf(itemOf(event.target) as Item),
      event.key,
      enabledItems(),
    );
    const key = ITEMS[index];
    if (!key) return;
    event.preventDefault();
    item(key)?.focus();
  };

  const onToolbarFocus = (event: React.FocusEvent) => {
    const key = itemOf(event.target);
    if (!key) return;
    roving.current = key;
    placeTabStop();
  };

  const itemProps = (key: Item) => ({ 'data-titlebar-item': key, onMouseDown: keepFocus });

  const control = (action: WindowAction) => async () => {
    await windowControl(action);
    void refreshWindowState();
  };

  // The press, told to the shell while Windows still reports the mouse
  // button down: it opens the menu for the click that follows only if it saw
  // this press on the button (frame.rs). This call opens nothing itself.
  const pressMenu = (event: React.PointerEvent) => {
    const at = menuAt();
    if (event.button === 0 && at && !menuBusy.current) void showAppMenu(at.x, at.y);
  };

  const ghost =
    'items-center justify-center rounded-md text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]';
  const caption =
    'flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] active:bg-[var(--bg-hover)]/70';

  const maximise = win.fullscreen
    ? { label: 'Exit full screen', action: 'exit-full-screen' as const }
    : win.maximized
      ? { label: 'Restore', action: 'toggle-maximize' as const }
      : { label: 'Maximise', action: 'toggle-maximize' as const };

  return (
    <div
      ref={rootRef}
      data-titlebar=""
      // Full screen has nothing to move or maximise: the bar stops dragging.
      data-tauri-drag-region={win.fullscreen ? 'false' : 'deep'}
      data-titlebar-ready={ready ? '' : undefined}
      data-maximized={win.maximized ? '' : undefined}
      data-fullscreen={win.fullscreen ? '' : undefined}
      // Right-click on a control would show the page's own menu (Reload,
      // Inspect); on the empty bar Windows shows the window menu instead.
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        // Emerald in both themes, like the rail (`dark` re-scopes the tokens).
        // `pointer-events-auto`: a modal dialog sets `pointer-events: none` on
        // <body>, and the window must still move, minimise and close. A fixed
        // h-10 rather than --titlebar-h, because CSS zoom scales it (globals.css).
        'dark pointer-events-auto fixed inset-x-0 top-0 z-[var(--z-titlebar)] hidden h-10 cursor-default items-center text-[var(--fg)] select-none [:root[data-desktop-frame]_&]:flex',
        // The colour of what is under it, so the bar reads as the top of the
        // columns below rather than a strip of its own: the page-header band
        // over the content (and the sign-in band), and in a narrow window the
        // phone header's own see-through emerald, so the two still match
        // when the page scrolls under both. Over the rail, the rail's own
        // tint (below).
        'bg-[var(--bg-band)] max-lg:[:root:has([data-app-shell])_&]:bg-[var(--bg-sidebar)]/95 max-lg:[:root:has([data-app-shell])_&]:backdrop-blur',
      )}
    >
      {/* The rail, carried up into the bar (app pages, wide windows): its top
          tint, opaque, and its gold edge fading out towards the top. Below
          the toolbar (-z), so they never cover a control. Widths are scaled
          back by --zoom-comp, because the bar itself is zoomed. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 -z-10 hidden w-[calc(16rem*var(--zoom-comp,1))] bg-[var(--bg-sidebar)] bg-[linear-gradient(rgb(31_90_70/0.25),rgb(31_90_70/0.25))] lg:[:root:has([data-app-shell])_&]:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-[calc(16rem*var(--zoom-comp,1)-1px)] -z-10 hidden w-px bg-[linear-gradient(180deg,transparent,rgb(212_175_55/0.25))] lg:[:root:has([data-app-shell])_&]:block"
      />
      {/* Slack's inset corners: the page column hangs from the bar and rail
          like a panel with rounded top corners. In the band's colour, so at
          rest, over the page-header band, they cannot be seen; they show
          when the page scrolls up under the bar. Not under the demo banner,
          which runs the full width between the bar and the page. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-full left-[calc(16rem*var(--zoom-comp,1))] hidden size-2.5 bg-[radial-gradient(circle_at_100%_100%,transparent_10px,var(--bg-band)_10.5px)] lg:[:root:has([data-app-shell]):not(:has(.has-demo-banner))_&]:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-full right-0 hidden size-2.5 bg-[radial-gradient(circle_at_0%_100%,transparent_10px,var(--bg-band)_10.5px)] lg:[:root:has([data-app-shell]):not(:has(.has-demo-banner))_&]:block"
      />

      <div
        role="toolbar"
        aria-label="Title bar"
        onKeyDown={onToolbarKeyDown}
        onFocus={onToolbarFocus}
        // No `position` here: Search is placed against the bar, centred on
        // the window. 80px on a Mac for the traffic lights, 12px in full
        // screen, where they hide.
        className="flex h-full items-center gap-0.5 pl-1.5 [:root[data-desktop-frame=mac]_&]:pl-20 [:root[data-desktop-frame=mac]_[data-fullscreen]_&]:pl-3"
      >
        <button
          ref={menuRef}
          type="button"
          tabIndex={-1}
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-keyshortcuts="Alt F10"
          title="Menu (Alt)"
          onMouseDown={keepFocus}
          onPointerDown={pressMenu}
          onClick={() => void openMenu()}
          className={cn(ghost, 'mr-1 hidden h-7 w-9 [:root[data-desktop-frame=windows]_&]:flex')}
        >
          <MenuGlyph />
        </button>

        <span data-titlebar-nav="" className="flex gap-0.5">
          <button
            type="button"
            {...itemProps('back')}
            aria-label="Back"
            title="Back"
            disabled={!back}
            onClick={() => window.history.back()}
            className={cn(
              ghost,
              'flex size-7 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--fg-muted)]',
            )}
          >
            <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            {...itemProps('forward')}
            aria-label="Forward"
            title="Forward"
            disabled={!forward}
            onClick={() => window.history.forward()}
            className={cn(
              ghost,
              'flex size-7 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--fg-muted)]',
            )}
          >
            <ArrowRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>

        {/* App pages only (the palette lives in the app layout). Width in %
            of the bar, not vw, so it stays right inside the zoomed bar: at
            1024px and up 40% clears the 256px rail, and at the 800px window
            minimum its 320px clears both ends of the bar. */}
        <button
          type="button"
          {...itemProps('search')}
          aria-label="Search Kraken"
          aria-keyshortcuts={frame === 'mac' ? 'Meta+K' : 'Control+K'}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          onClick={openSearch}
          className="text-note absolute top-1/2 left-1/2 hidden h-7 w-[min(36rem,40%)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-hover)]/60 px-2.5 text-left text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] aria-expanded:bg-[var(--bg-hover)] aria-expanded:text-[var(--fg)] [:root:has([data-app-shell])_&]:flex"
        >
          <Search className="size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
          <span className="truncate">Search Kraken</span>
          <kbd
            aria-hidden="true"
            className="ml-auto hidden font-sans text-[11px] text-[var(--fg-subtle)] [:root[data-desktop-frame=windows]_&]:inline"
          >
            Ctrl K
          </kbd>
          <kbd
            aria-hidden="true"
            className="ml-auto hidden font-sans text-[11px] text-[var(--fg-subtle)] [:root[data-desktop-frame=mac]_&]:inline"
          >
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Windows' own caption buttons, drawn here: full height, 46px wide, out
          of the tab order like the native ones (Win+Down, Win+Up and Alt+F4
          are the keyboard's way). Close turns Windows red. */}
      <div
        role="group"
        aria-label="Window controls"
        className="ml-auto hidden h-full [:root[data-desktop-frame=windows]_&]:flex"
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label="Minimise"
          title="Minimise"
          onMouseDown={keepFocus}
          onClick={control('minimize')}
          className={caption}
        >
          <MinimiseGlyph />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={maximise.label}
          title={maximise.label}
          onMouseDown={keepFocus}
          onClick={control(maximise.action)}
          className={caption}
        >
          {win.fullscreen ? (
            <ExitFullScreenGlyph />
          ) : (
            // CSS picks one: html[data-desktop-maximized] is set before first
            // paint from the last state seen, then kept in step (above).
            <>
              <span className="flex [:root[data-desktop-maximized]_&]:hidden">
                <MaximiseGlyph />
              </span>
              <span className="hidden [:root[data-desktop-maximized]_&]:flex">
                <RestoreGlyph />
              </span>
            </>
          )}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close window"
          title="Close"
          onMouseDown={keepFocus}
          onClick={control('close')}
          className={cn(
            caption,
            'hover:bg-[var(--titlebar-close)] hover:text-white active:bg-[var(--titlebar-close-pressed)] active:text-white',
          )}
        >
          <CloseGlyph />
        </button>
      </div>
    </div>
  );
}
