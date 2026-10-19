'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { desktopAppVersion } from '@/lib/desktop/shared';
import { iosAppVersion, type AlertsPreference, type IosAlertsStatus } from '@/lib/ios/shared';
import { AlertsSummary } from './alerts-summary';

type State =
  'loading' | 'desktop' | 'ios-app' | 'unsupported' | 'install' | 'denied' | 'off' | 'on';

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? null;
}

/**
 * Settings > Preferences: turn phone alerts on for this device. Alerts are for
 * money or legal items going stale, the morning top 3, LPs and founders waiting
 * on you, portfolio companies newly at risk, and a campaign that finished
 * sending; 8am-8pm only.
 *
 * Inside the desktop app this renders nothing: the Desktop alerts card
 * (desktop-alerts.tsx) takes its place. `desktopHint` is the app's version
 * from its cookie, so the server render already leaves it out there. Inside
 * the iPhone app likewise (no web push there; ios-alerts.tsx instead), with
 * `iosHint` from its user agent.
 *
 * On an iPhone whose person also has the iPhone app (`ios`, the server's
 * view), this home-screen app says whether the app has their alerts, which
 * holds web push back here, and offers "Send alerts here instead" (and the
 * way back).
 */
export function PushAlertsSetting({
  publicKey,
  desktopHint = null,
  iosHint = null,
  ios = null,
}: {
  publicKey: string;
  desktopHint?: string | null;
  iosHint?: string | null;
  ios?: IosAlertsStatus | null;
}) {
  const [state, setState] = React.useState<State>('loading');
  const [busy, setBusy] = React.useState(false);
  const [preference, setPreference] = React.useState<AlertsPreference>(ios?.preference ?? 'app');

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: State;
      if (desktopAppVersion()) {
        // Checked first: the Windows app's webview has every API this tests
        // for and still has no push service, so subscribing would only fail.
        // The Desktop alerts card covers this computer instead.
        next = 'desktop';
      } else if (iosAppVersion()) {
        // The iPhone app's web view has no web push; its own card covers it.
        next = 'ios-app';
      } else if (
        !('Notification' in window) ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        next = isIos() && !isStandalone() ? 'install' : 'unsupported';
      } else if (Notification.permission === 'denied') {
        next = 'denied';
      } else {
        const reg = await registration();
        const sub = await reg?.pushManager.getSubscription();
        next = sub ? 'on' : 'off';
        // A subscription from before Copilot kept which phone made it: saved
        // again, quietly, so an iPhone's is known as one (lib/services/ios-push.ts).
        if (sub && isIos()) {
          void fetch('/api/push/subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub.toJSON()),
          }).catch(() => null);
        }
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }));
      const res = await fetch('/api/push/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState('on');
      toast.success('Phone alerts are on for this device.');
    } catch {
      toast.error('Could not turn on alerts. Try again from the installed app.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await registration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/subscription', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState('off');
      toast.success('Phone alerts are off for this device.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const reg = await registration();
    await reg?.showNotification('TipTop Copilot', {
      body: 'Alerts work on this device.',
      icon: '/icon-192.png',
      data: { url: '/today' },
    });
  };

  const choose = async (to: AlertsPreference) => {
    setBusy(true);
    try {
      const res = await fetch('/api/push/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreference(to);
      toast.success(
        to === 'web' ? 'Alerts come here instead.' : 'Alerts go to the iPhone app again.',
      );
    } catch {
      toast.error('Couldn’t change that just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'desktop' || (state === 'loading' && desktopHint)) return null;
  if (state === 'ios-app' || (state === 'loading' && iosHint)) return null;

  // Only on an iPhone with alerts on here, when the same person has the app.
  const iphoneWithApp = state === 'on' && ios !== null && ios.devices > 0 && isIos();

  return (
    <div>
      <p className="text-sm font-medium">Phone alerts</p>
      <AlertsSummary />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state === 'loading' ? (
          <span className="text-sm text-[var(--fg-subtle)]">Checking this device…</span>
        ) : null}
        {state === 'off' ? (
          <Button variant="primary" onClick={enable} disabled={busy}>
            <Bell aria-hidden /> Enable alerts on this device
          </Button>
        ) : null}
        {state === 'on' ? (
          <>
            <span className="text-sm">On for this device.</span>
            <Button size="sm" onClick={test}>
              Send a test
            </Button>
            <Button size="sm" variant="ghost" onClick={disable} disabled={busy}>
              <BellOff aria-hidden /> Turn off
            </Button>
          </>
        ) : null}
        {state === 'install' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            On iPhone, first add the Copilot to your Home Screen (Share, then Add to Home Screen),
            open it from there, and come back to this page.
          </span>
        ) : null}
        {state === 'denied' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            Notifications are blocked for this app. Allow them in your phone&apos;s settings, then
            reload.
          </span>
        ) : null}
        {state === 'unsupported' ? (
          <span className="text-sm text-[var(--fg-muted)]">
            This browser cannot receive alerts. Use the installed app on your phone.
          </span>
        ) : null}
      </div>
      {iphoneWithApp && preference === 'web' ? (
        <Notice className="mt-3">
          <div>
            <p>Your alerts come here instead of the TipTop Copilot iPhone app.</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => void choose('app')}
              disabled={busy}
            >
              Send them to the iPhone app
            </Button>
          </div>
        </Notice>
      ) : iphoneWithApp && ios.active && ios.senderReady ? (
        <Notice className="mt-3">
          <div>
            <p>
              Alerts now go to the TipTop Copilot iPhone app, so this home-screen app stays quiet.
              If the app stops checking in, they come back here by themselves.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => void choose('web')}
              disabled={busy}
            >
              Send alerts here instead
            </Button>
          </div>
        </Notice>
      ) : null}
    </div>
  );
}
