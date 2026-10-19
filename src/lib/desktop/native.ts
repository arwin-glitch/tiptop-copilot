/**
 * The few things the page asks the desktop app's shell to do. The shell
 * grants the live site exactly these, in its main window only
 * (desktop/src-tauri/capabilities/ and permissions/): for the top bar
 * (D-056), move, minimise, maximise and close that window, read its state,
 * and open the File, Edit and View menu under the bar's menu button; for
 * desktop alerts (0.4.0, D-057), turn them on or off for this computer, read
 * whether they are on and allowed, ask the system for permission, show the
 * fixed test notification, and ask for the next poll within half a minute
 * (0.4.1, D-058). The page can hand the shell its alerts token but never
 * read it back, and no call shows text the page supplies; the shell takes
 * any token for its own device id, so the page decides which organization's
 * alerts this computer follows.
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

/* --------------------------------------------------------- desktop alerts */

/**
 * Whether the system lets the app show notifications: `prompt` until the
 * person has answered macOS's question, `unavailable` where this copy of the
 * app cannot show them at all.
 */
export type DesktopAlertsPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/** What the shell says about desktop alerts on this computer. */
export interface DesktopAlertsStatus {
  on: boolean;
  permission: DesktopAlertsPermission;
  /** This computer's id: 32 hex characters, the same until the app's data is removed. */
  device: string;
  platform: 'mac' | 'windows';
}

const PERMISSIONS: readonly string[] = ['granted', 'denied', 'prompt', 'unavailable'];

function alertsStatus(value: unknown): DesktopAlertsStatus | null {
  if (!value || typeof value !== 'object') return null;
  const { on, permission, device, platform } = value as Record<string, unknown>;
  if (typeof on !== 'boolean') return null;
  if (typeof permission !== 'string' || !PERMISSIONS.includes(permission)) return null;
  if (typeof device !== 'string' || !/^[0-9a-f]{32}$/.test(device)) return null;
  if (platform !== 'mac' && platform !== 'windows') return null;
  return { on, permission: permission as DesktopAlertsPermission, device, platform };
}

/** Desktop alerts on this computer, or null outside a 0.4.0+ main window or for anything unexpected. */
export async function desktopAlertsState(): Promise<DesktopAlertsStatus | null> {
  return alertsStatus(await call('alerts_state', {}));
}

/** Asks the system for permission where it has not been asked (a Mac's first time). */
export async function requestDesktopAlertsPermission(): Promise<DesktopAlertsStatus | null> {
  return alertsStatus(await call('alerts_request_permission', {}));
}

/** Hands the shell this computer's token from /api/push/desktop. Not `on` unless it took it. */
export async function turnOnDesktopAlerts(token: string): Promise<DesktopAlertsStatus | null> {
  return alertsStatus(await call('alerts_turn_on', { token }));
}

/** The shell forgets its token and tells Copilot to turn this computer off. */
export async function turnOffDesktopAlerts(): Promise<DesktopAlertsStatus | null> {
  return alertsStatus(await call('alerts_turn_off', {}));
}

/** The shell's fixed test notification: "Alerts work on this computer." */
export async function testDesktopAlert(): Promise<DesktopAlertsStatus | null> {
  return alertsStatus(await call('alerts_test', {}));
}

/**
 * Asks the shell to look for this computer's alerts within half a minute
 * (0.4.1+): called when a question to Ask Arwin starts waiting, so its answer
 * pings even at night, when the shell otherwise waits until 6am. Shows
 * nothing itself; does nothing while alerts are off, and an app before 0.4.1
 * refuses it (quietly: this resolves either way).
 */
export async function pollDesktopAlertsSoon(): Promise<void> {
  await call('alerts_poll_soon', {});
}
