'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import {
  readIosAlertsState,
  sendTestAlert,
  turnOffIosAlerts,
  turnOnIosAlerts,
  type IosAlertsState,
} from '@/lib/ios/alerts-client';
import {
  IOS_BUILD_STALE_DAYS,
  IOS_BUILD_WARN_DAYS,
  type AlertsPreference,
  type IosAlertsStatus,
} from '@/lib/ios/shared';
import { useIosApp } from '@/lib/ios/use-ios-app';
import { AlertsSummary } from './alerts-summary';

type Mode = { kind: 'loading' } | IosAlertsState;

/**
 * Settings > Preferences inside the iPhone app: the same alerts as phone and
 * desktop alerts, through Apple's push service (lib/services/ios-push.ts;
 * D-058). Off until someone turns them on here: the app never asks for
 * permission at launch. Takes the place of the home-screen web push card,
 * which cannot work in the app.
 *
 * On: Send a test alert (a real one, through the sender) and Turn off. Asks
 * for the TestFlight update once the build is getting old, and offers the
 * way back when "Send alerts here instead" was chosen in the web app.
 *
 * `iosHint` is the app's version from the server render; `status` the
 * person's app alerts as the server sees them.
 */
export function IosAlertsSetting({
  iosHint = null,
  status,
}: {
  iosHint?: string | null;
  status: IosAlertsStatus | null;
}) {
  const inApp = Boolean(useIosApp(iosHint));
  const [mode, setMode] = React.useState<Mode>({ kind: 'loading' });
  const [busy, setBusy] = React.useState(false);
  const [preference, setPreference] = React.useState<AlertsPreference>(status?.preference ?? 'app');

  const refresh = React.useCallback(async () => {
    setMode(await readIosAlertsState());
  }, []);

  React.useEffect(() => {
    if (!inApp) return;
    let cancelled = false;
    void readIosAlertsState().then((next) => {
      if (!cancelled) setMode(next);
    });
    // Back from the iPhone's Settings app: read permission again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [inApp, refresh]);

  if (!inApp) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const result = await turnOnIosAlerts();
      setMode(result.state);
      if (result.state.kind === 'on') toast.success('Alerts are on for this iPhone.');
      else if (result.message) toast.error(result.message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const done = await turnOffIosAlerts('settings');
      if (done) {
        setMode({ kind: 'off' });
        toast.success('Alerts are off for this iPhone.');
      } else {
        toast.error('Couldn’t turn alerts off just now. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const problem = await sendTestAlert();
      if (problem) toast.error(problem);
      else {
        toast.success(
          'Test alert on its way. It arrives within about a minute, 6am to 9pm Central.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const backToApp = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/push/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'app' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreference('app');
      toast.success('Alerts come to this app again.');
    } catch {
      toast.error('Couldn’t change that just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const age = mode.kind === 'on' ? mode.buildAgeDays : null;
  // Sent to the home-screen web app instead, as chosen there: only when that
  // web app still has alerts on (the server's status says which).
  const webChosen =
    preference === 'web' && status !== null && status.devices > 0 && !status.appHasAlerts;
  // No alert job with a working Apple key lately (just after the key is
  // added, the running job picks it up only when its run ends).
  const unreachable = status !== null && !status.senderReady;

  return (
    <div data-ios-alerts={mode.kind}>
      <p className="text-sm font-medium">iPhone alerts</p>
      <AlertsSummary />
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        They come even when the app is closed. Signing out turns them off on this iPhone.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode.kind === 'loading' ? (
          <span className="text-sm text-[var(--fg-subtle)]">Checking this iPhone…</span>
        ) : null}
        {mode.kind === 'prompt' || mode.kind === 'off' ? (
          <Button variant="primary" onClick={enable} disabled={busy}>
            <Bell aria-hidden /> Turn on alerts on this iPhone
          </Button>
        ) : null}
        {mode.kind === 'on' ? (
          <>
            <span className="text-sm">On for this iPhone.</span>
            <Button size="sm" onClick={test} disabled={busy || unreachable}>
              Send a test alert
            </Button>
            <Button size="sm" variant="ghost" onClick={disable} disabled={busy}>
              <BellOff aria-hidden /> Turn off
            </Button>
          </>
        ) : null}
        {mode.kind === 'denied' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            Notifications are off for this app. Turn them on in the iPhone’s Settings app, under
            Notifications, then TipTop, and come back here.
          </span>
        ) : null}
        {mode.kind === 'theirs' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            Someone else turned on alerts for this iPhone. Ask them, or an admin, to turn them off
            first.
          </span>
        ) : null}
        {mode.kind === 'unavailable' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            This version of the app can’t get alerts. Open TestFlight and install the update.
          </span>
        ) : null}
        {mode.kind === 'unknown' ? (
          <>
            <span className="text-sm text-[var(--fg-muted)]">
              Couldn’t check alerts on this iPhone just now.
            </span>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
              Try again
            </Button>
          </>
        ) : null}
      </div>
      {mode.kind === 'on' && unreachable ? (
        <Notice tone="warn" className="mt-3">
          <p>
            Copilot can’t send to this app yet: the alert job doesn’t have a working Apple push key.
            Until it does, your alerts go to your other phones.
          </p>
        </Notice>
      ) : null}
      {mode.kind === 'on' && webChosen ? (
        <Notice className="mt-3">
          <div>
            <p>Your alerts go to the home-screen web app instead, as chosen there.</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={backToApp}
              disabled={busy}
            >
              Send them to this app
            </Button>
          </div>
        </Notice>
      ) : null}
      {age !== null && age >= IOS_BUILD_WARN_DAYS ? (
        <Notice tone="warn" className="mt-3">
          <p>
            This version of the app is {age} days old. Open TestFlight and install the update:
            TestFlight versions stop opening after 90 days.
            {age >= IOS_BUILD_STALE_DAYS
              ? ' Until you do, alerts also go to the home-screen web app, if you have it.'
              : ''}
          </p>
        </Notice>
      ) : null}
    </div>
  );
}
