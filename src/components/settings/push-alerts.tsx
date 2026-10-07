'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

type State = 'loading' | 'unsupported' | 'install' | 'denied' | 'off' | 'on';

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
 * on you, and portfolio companies newly at risk; 8am-8pm only.
 */
export function PushAlertsSetting({ publicKey }: { publicKey: string }) {
  const [state, setState] = React.useState<State>('loading');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: State;
      if (
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

  return (
    <div>
      <p className="text-sm font-medium">Phone alerts</p>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        A ping when money or legal items go stale, your morning top 3, LPs and founders waiting on
        you, and portfolio companies newly at risk. Each item alerts once, 8am to 8pm only.
      </p>
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
    </div>
  );
}
