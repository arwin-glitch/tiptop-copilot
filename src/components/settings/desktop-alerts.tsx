'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  askAlertsShell,
  desktopAppVersion,
  desktopAlertsShell,
  desktopFrame,
  type DesktopComputer,
} from '@/lib/desktop/shared';
import {
  desktopAlertsState,
  requestDesktopAlertsPermission,
  testDesktopAlert,
  turnOffDesktopAlerts,
  turnOnDesktopAlerts,
  type DesktopAlertsStatus,
} from '@/lib/desktop/native';
import { formatMonthDay } from '@/lib/util/time';
import { AlertsSummary } from './alerts-summary';

type Mode =
  /** Not inside the desktop app: only the list, when there is one. */
  | { kind: 'browser' }
  | { kind: 'loading' }
  /** An app older than 0.4.0. */
  | { kind: 'update' }
  /** An attachment or briefing window, which has no access to the shell's alerts. */
  | { kind: 'other-window' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: DesktopAlertsStatus };

const COULD_NOT = 'Could not turn on desktop alerts. Try again.';

function initialMode(desktopHint: string | null): Mode {
  if (!desktopHint) return { kind: 'browser' };
  return desktopAlertsShell(desktopHint) ? { kind: 'loading' } : { kind: 'update' };
}

/** Turn a computer off on the server. Never throws; status 0 when it could not be reached. */
async function turnOffOnServer(
  device: string,
): Promise<{ ok: boolean; status: number; message: string | null }> {
  try {
    const res = await fetch('/api/push/desktop', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    });
    if (res.ok) return { ok: true, status: res.status, message: null };
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, status: res.status, message: body?.error?.message ?? null };
  } catch {
    return { ok: false, status: 0, message: null };
  }
}

/** Whether Kraken has this computer turned on; null when it could not say. Never throws. */
async function onAtCopilot(device: string): Promise<boolean | null> {
  try {
    const res = await fetch(`/api/push/desktop?device=${encodeURIComponent(device)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { on?: unknown } | null;
    return typeof body?.on === 'boolean' ? body.on : null;
  } catch {
    return null;
  }
}

/**
 * Settings > Preferences: desktop alerts, the same alerts as phone alerts,
 * shown by the desktop app on this computer (0.4.0 and newer; D-057), and
 * from 0.4.1 Ask Arwin's answers to your own questions (D-058). Off until
 * someone turns them on here, per computer.
 *
 * Inside the app's main window: Enable (asks the system for permission,
 * gets this computer's token from /api/push/desktop and hands it to the
 * shell, which never gives it back), Send a test and Turn off, or why it
 * cannot. In a browser: just the computers that have them on, each with
 * Turn off for whoever turned it on, or an admin.
 *
 * `computers` is null when the list could not be read, which hides it.
 */
export function DesktopAlertsSetting({
  computers,
  desktopHint = null,
  timeZone,
}: {
  computers: DesktopComputer[] | null;
  desktopHint?: string | null;
  timeZone: string;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>(() => initialMode(desktopHint));
  // Ask Arwin's answers alert only from 0.4.1 (D-058): an older app, which
  // may wait days on Later, is not promised them.
  const [askAlerts, setAskAlerts] = React.useState(() => askAlertsShell(desktopHint));
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  // The list as this card first rendered it, for the one check on mount.
  const [firstComputers] = React.useState(computers);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const version = desktopAppVersion();
      let next: Mode;
      if (!version) next = { kind: 'browser' };
      else if (!desktopAlertsShell(version)) next = { kind: 'update' };
      // The frame flag is set in the main window only, the one the shell
      // lets use its alerts commands.
      else if (!desktopFrame()) next = { kind: 'other-window' };
      else {
        let status = await desktopAlertsState();
        // On here but not in the list: turned off from another device while
        // the app was closed, or only a list from before Enable (Settings
        // unmounts a tab that is left, so this runs again on coming back,
        // maybe before the page refreshed). Kraken decides: only its "not
        // on" turns the shell off, never a list, and never a failed read.
        const device = status?.device;
        if (status?.on && device && !firstComputers?.some((c) => c.device === device)) {
          if ((await onAtCopilot(device)) === false) {
            status = (await turnOffDesktopAlerts()) ?? { ...status, on: false };
          }
        }
        next = status ? { kind: 'ready', status } : { kind: 'unavailable' };
      }
      if (!cancelled) {
        setMode(next);
        setAskAlerts(askAlertsShell(version));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstComputers]);

  // Coming back from System Settings: read permission again. Not while
  // turning on or off, which reads and sets the state itself.
  const appWindow = mode.kind === 'ready' || mode.kind === 'unavailable';
  React.useEffect(() => {
    if (!appWindow || busy) return;
    const reread = async () => {
      const status = await desktopAlertsState();
      setMode(status ? { kind: 'ready', status } : { kind: 'unavailable' });
    };
    const onFocus = () => void reread();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [appWindow, busy]);

  const enable = async () => {
    setBusy(true);
    try {
      const asked = await requestDesktopAlertsPermission();
      if (!asked) {
        setMode({ kind: 'unavailable' });
        return;
      }
      setMode({ kind: 'ready', status: asked });
      if (asked.permission === 'prompt') {
        toast('Answer the notification question from macOS, then click Enable again.');
        return;
      }
      if (asked.permission !== 'granted') return;
      const res = await fetch('/api/push/desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: asked.device,
          platform: asked.platform,
          version: desktopAppVersion(),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        token?: unknown;
        error?: { message?: string };
      } | null;
      if (!res.ok || typeof body?.token !== 'string') {
        toast.error(body?.error?.message ?? COULD_NOT);
        return;
      }
      const on = await turnOnDesktopAlerts(body.token);
      if (!on?.on) {
        // The shell did not take it: nothing must be left on the server.
        await turnOffOnServer(asked.device);
        if (on) setMode({ kind: 'ready', status: on });
        toast.error(COULD_NOT);
        return;
      }
      setMode({ kind: 'ready', status: on });
      toast.success('Desktop alerts are on for this computer.');
      router.refresh();
    } catch {
      toast.error(COULD_NOT);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (status: DesktopAlertsStatus) => {
    setBusy(true);
    try {
      // The shell first, so it stops asking even if the server is out of reach.
      const off = await turnOffDesktopAlerts();
      const server = await turnOffOnServer(off?.device ?? status.device);
      setMode({ kind: 'ready', status: off ?? { ...status, on: false } });
      // A 403: the computer's row is someone else's, and the shell's own
      // request (with its token) takes it off anyway.
      if (server.ok || server.status === 403) {
        toast.success('Desktop alerts are off for this computer.');
      } else {
        toast.error(
          'Off on this computer, but Kraken could not be told. If it is still listed below, turn it off there.',
        );
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const turnOffListed = async (device: string, here: boolean) => {
    setBusy(true);
    try {
      const result = await turnOffOnServer(device);
      if (!result.ok) {
        toast.error(result.message ?? 'Could not turn off that computer. Try again.');
        return;
      }
      toast.success(
        here
          ? 'Desktop alerts are off for this computer.'
          : 'Desktop alerts are off for that computer.',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    // The shell shows one test every 3 seconds at most.
    setTesting(true);
    window.setTimeout(() => setTesting(false), 3000);
    if (!(await testDesktopAlert())) toast.error('Could not send a test. Try again.');
  };

  const here = mode.kind === 'ready' ? mode.status : null;
  const list =
    computers && computers.length ? (
      <ComputerList
        computers={computers}
        here={here}
        // Not until this computer's row is known, so it never offers to turn
        // itself off as "that computer"; a second window sends you to the main one.
        actions={mode.kind !== 'loading' && mode.kind !== 'other-window'}
        timeZone={timeZone}
        busy={busy}
        onTurnOff={turnOffListed}
      />
    ) : null;

  if (mode.kind === 'browser') {
    if (!list) return null;
    return (
      <div>
        <p className="text-sm font-medium">Desktop alerts</p>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          On for these computers. Turn alerts on or off from the desktop app’s Settings, or turn a
          computer off here.
        </p>
        {list}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium">Desktop alerts</p>
      <AlertsSummary />
      {mode.kind === 'update' ? (
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          Phone alerts are separate: turn them on from Kraken on your phone.
        </p>
      ) : (
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          {askAlerts
            ? 'On this computer they also come, at any hour, when Arwin answers your question, unless you’re looking at the app. '
            : null}
          Alerts come while the app is running, even with its window closed (it stays in the tray on
          Windows and in the Dock on a Mac). Quitting the app pauses them until you open it again;
          signing out turns them off on this computer. Phone alerts are separate: turn them on from
          Kraken on your phone.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode.kind === 'loading' ? (
          <span className="text-sm text-[var(--fg-subtle)]">Checking this computer…</span>
        ) : null}
        {mode.kind === 'update' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            Update the app to get desktop alerts.
          </span>
        ) : null}
        {mode.kind === 'other-window' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            Open Settings in the main window to turn desktop alerts on or off.
          </span>
        ) : null}
        {mode.kind === 'unavailable' ? <Unavailable /> : null}
        {mode.kind === 'ready' ? (
          <Controls
            status={mode.status}
            busy={busy}
            testing={testing}
            onEnable={enable}
            onTest={test}
            onTurnOff={() => turnOff(mode.status)}
          />
        ) : null}
      </div>
      {list}
    </div>
  );
}

function Unavailable() {
  return (
    <span className="text-sm text-[var(--fg-muted)]">
      Desktop alerts can’t be turned on in this copy of the app.
    </span>
  );
}

function Controls({
  status,
  busy,
  testing,
  onEnable,
  onTest,
  onTurnOff,
}: {
  status: DesktopAlertsStatus;
  busy: boolean;
  testing: boolean;
  onEnable: () => void;
  onTest: () => void;
  onTurnOff: () => void;
}) {
  const turnOff = status.on ? (
    <Button size="sm" variant="ghost" onClick={onTurnOff} disabled={busy}>
      <BellOff aria-hidden /> Turn off
    </Button>
  ) : null;
  if (status.permission === 'denied') {
    return (
      <>
        <span className="text-sm text-[var(--fg-muted)]">
          {status.platform === 'mac'
            ? 'Notifications are blocked for TipTop Kraken. Allow them in System Settings > Notifications > TipTop Kraken, then come back to this page.'
            : 'Notifications are off for TipTop Kraken. Turn them on in Windows Settings > System > Notifications (Notifications & actions on Windows 10), then come back to this page.'}
        </span>
        {turnOff}
      </>
    );
  }
  if (status.permission === 'unavailable') {
    return (
      <>
        <Unavailable />
        {turnOff}
      </>
    );
  }
  // On, but macOS has forgotten its answer (`prompt`): Enable asks again.
  if (status.on && status.permission === 'granted') {
    return (
      <>
        <span className="text-sm">On for this computer.</span>
        <Button size="sm" onClick={onTest} disabled={testing}>
          Send a test
        </Button>
        {turnOff}
      </>
    );
  }
  return (
    <Button variant="primary" onClick={onEnable} disabled={busy}>
      <Bell aria-hidden /> Enable alerts on this computer
    </Button>
  );
}

const PLATFORM_NAMES = { mac: 'Mac', windows: 'Windows' } as const;

/**
 * The organization's computers with desktop alerts on. Each row carries the
 * end of its id, so two Windows PCs turned on the same day can be told apart
 * (and matched with the app's own list). Turn off for those the viewer may
 * turn off; on this computer's own row only once the shell is off but
 * Kraken still lists it (Turn off above could not reach Kraken).
 */
function ComputerList({
  computers,
  here,
  actions,
  timeZone,
  busy,
  onTurnOff,
}: {
  computers: DesktopComputer[];
  /** What the shell says about this computer, in the app's main window. */
  here: DesktopAlertsStatus | null;
  actions: boolean;
  timeZone: string;
  busy: boolean;
  onTurnOff: (device: string, here: boolean) => void;
}) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-[var(--fg-muted)]">Computers with desktop alerts</p>
      <ul className="mt-1 divide-y divide-[var(--border)]">
        {computers.map((c) => {
          const label = `${PLATFORM_NAMES[c.platform]} (ID ${c.shortId}) · on since ${formatMonthDay(c.enabledAt, timeZone)}`;
          const isHere = here !== null && c.device === here.device;
          const device = c.canTurnOff ? c.device : null;
          const offer = actions && (!isHere || !here?.on);
          return (
            <li key={c.id} className="flex min-h-9 items-center gap-2 py-1 text-sm">
              <span className="min-w-0 flex-1">
                {label}
                {isHere ? ' · this computer' : ''}
              </span>
              {offer && device ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onTurnOff(device, isHere)}
                  disabled={busy}
                  aria-label={`Turn off desktop alerts for ${label}`}
                >
                  Turn off
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
