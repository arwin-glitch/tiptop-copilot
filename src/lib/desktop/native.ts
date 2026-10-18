/**
 * The few things the desktop app's top bar asks the shell to do. The shell
 * grants the live site exactly these, in its main window only
 * (desktop/src-tauri/capabilities/ and permissions/; D-056): move, minimise,
 * maximise and close that window, read its state, and open the File, Edit
 * and View menu under the bar's menu button.
 *
 * Client-only, and every call is a no-op outside the app: there is no
 * `@tauri-apps/api` here, only the shell's own `__TAURI_INTERNALS__.invoke`,
 * looked up at call time. A refused or failed call resolves quietly, because
 * a window control that fails must never throw into React.
 */

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close' | 'exit-full-screen';

export interface WindowFrameState {
  maximized: boolean;
  fullscreen: boolean;
  /** This window's View > Zoom: 1 when never set. */
  zoom: number;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function bridge(): Invoke | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return typeof invoke === 'function' ? (invoke.bind(internals) as Invoke) : null;
}

async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const invoke = bridge();
  if (!invoke) return null;
  try {
    // `await` turns a rejection (a call the shell refused) into the catch below.
    return await invoke(cmd, args);
  } catch {
    return null;
  }
}

/** Whether the shell's IPC is on this page (it is in every window of every app version). */
export function hasNativeBridge(): boolean {
  return bridge() !== null;
}

export async function windowControl(action: WindowAction): Promise<void> {
  await call('window_control', { action });
}

/** The window's state, or null outside the app or for anything but the expected shape. */
export async function windowFrame(): Promise<WindowFrameState | null> {
  const value = await call('window_frame', {});
  if (!value || typeof value !== 'object') return null;
  const { maximized, fullscreen, zoom } = value as Record<string, unknown>;
  if (typeof maximized !== 'boolean' || typeof fullscreen !== 'boolean') return null;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) return null;
  return { maximized, fullscreen, zoom };
}

/**
 * Opens the app menu with its top-left corner at (x, y): CSS px from the top
 * left of the page. Resolves once the menu has closed (Windows only).
 */
export async function showAppMenu(x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await call('show_app_menu', { x, y });
}
