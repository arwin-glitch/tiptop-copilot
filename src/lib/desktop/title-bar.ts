/**
 * The desktop app's top bar (components/desktop/desktop-title-bar.tsx): the
 * pure parts, tested without a browser, and the two DOM helpers other
 * overlays use to stay clear of it.
 */

/** The bar's root element. Hidden (0 high) everywhere but the desktop app. */
export const TITLEBAR_SELECTOR = '[data-titlebar]';
/** Back and Forward: the only bar controls that may dismiss an open dialog. */
const TITLEBAR_NAV_SELECTOR = '[data-titlebar-nav]';

/** Zoom levels the shell can report; anything else is read as 100%. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

export interface Point {
  x: number;
  y: number;
}

/**
 * Where the app menu opens, in CSS px from the top left of the page: its top
 * left corner on the menu button's left edge and the bar's bottom edge, the
 * way Slack's hangs from its bar.
 */
export function menuAnchor(button: { left: number }, bar: { bottom: number }): Point {
  return { x: Math.max(0, Math.round(button.left)), y: Math.max(0, Math.round(bar.bottom)) };
}

/**
 * The toolbar item an arrow key, Home or End moves to (WAI-ARIA toolbar
 * pattern): arrows wrap, disabled or hidden items are skipped, and with
 * nothing to move to the current item stays.
 */
export function nextToolbarIndex(current: number, key: string, enabled: boolean[]): number {
  const count = enabled.length;
  if (count === 0 || !enabled.some(Boolean)) return current;
  if (key === 'Home') return enabled.indexOf(true);
  if (key === 'End') return enabled.lastIndexOf(true);
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (step === 0) return current;
  let index = current;
  for (let i = 0; i < count; i++) {
    index = (((index + step) % count) + count) % count;
    if (enabled[index]) return index;
  }
  return current;
}

/** A zoom level the shell reported or the page cached; 1 for anything unusable. */
export function clampZoom(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_ZOOM &&
    value <= MAX_ZOOM
    ? value
    : 1;
}

/**
 * Whether the client hints `platform` and `platformVersion` mean Windows 10
 * or older. On Windows the version is the UniversalApiContract's, 13 and up
 * from Windows 11; the user agent string says "Windows NT 10.0" on both.
 */
export function isWindows10(platform: unknown, platformVersion: unknown): boolean {
  if (platform !== 'Windows') return false;
  if (typeof platformVersion !== 'string' || !/^\d+(\.\d+)*$/.test(platformVersion)) return false;
  return Number.parseInt(platformVersion, 10) < 13;
}

/**
 * How much of the top of the window the bar takes, in CSS px: 0 outside the
 * desktop app (the bar is not displayed), and smaller than 40 when the app is
 * zoomed in, since the bar keeps its size on screen.
 */
export function titleBarInset(): number {
  if (typeof document === 'undefined') return 0;
  return document.querySelector(TITLEBAR_SELECTOR)?.getBoundingClientRect().height ?? 0;
}

/**
 * For a dialog's `onPointerDownOutside`: a press on the bar (minimise, the
 * menu, search, moving the window) is not a click outside, so an open dialog
 * stays open. Back and Forward still close it, since they leave the page.
 */
export function ignoreTitleBarPointer(event: {
  target: EventTarget | null;
  preventDefault(): void;
}): void {
  const target = event.target;
  if (typeof Element === 'undefined' || !(target instanceof Element)) return;
  if (target.closest(TITLEBAR_SELECTOR) && !target.closest(TITLEBAR_NAV_SELECTOR)) {
    event.preventDefault();
  }
}
