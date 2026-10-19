'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isInAppAlertPath } from '@/lib/desktop/shared';
import { checkInIosAlerts } from '@/lib/ios/alerts-client';
import { inIosApp, onIosEvent } from '@/lib/ios/native';

/** An http(s) URL on this site, or null. */
function sameOrigin(href: string): URL | null {
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * Follow a link to this site in this window, as a click on a plain link: so
 * whatever guards links on the page still applies (a campaign that is
 * sending asks "Leave while sending?" first), and a link nothing stops is an
 * ordinary navigation.
 */
function followHere(url: URL, onFollow?: (href: string) => void): void {
  const link = document.createElement('a');
  link.href = url.href;
  link.hidden = true;
  if (onFollow) {
    link.addEventListener('click', (click) => {
      if (click.defaultPrevented) return;
      click.preventDefault();
      onFollow(`${url.pathname}${url.search}${url.hash}`);
    });
  }
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * A meeting alert's join link (/go/meeting?id=…), from inside the app. The
 * route's redirect to the call would be cut off half-way there, so the page
 * asks for the link and goes to it: Copilot's app hands any page that is not
 * Copilot's to the meeting app or Safari (and stays where it is). Not
 * window.open, which a web view refuses without a fresh tap.
 */
async function joinMeeting(path: string, openInApp: (href: string) => void): Promise<void> {
  let url: string | null = null;
  try {
    const res = await fetch(`${path}&format=json`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    url = typeof body?.url === 'string' && /^https:\/\//.test(body.url) ? body.url : null;
  } catch {
    url = null;
  }
  // An https address off this site (the call), which the app hands on.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (url) window.location.assign(url);
  else openInApp('/calendar');
}

/**
 * What the page does inside the iPhone app (ios-app/), apart from Settings
 * and sign-in. Mounted once, in the root layout; renders nothing, and does
 * nothing anywhere else.
 *
 * - Links to this site that open a new window (`target="_blank"`, and
 *   window.open) open in this window instead. The app would hand them to
 *   Safari, which has no Copilot session. Swiping back from the left edge
 *   returns, as the app has no browser bar. Links to anywhere else still go
 *   to Safari or the matching app.
 * - A tap on an alert opens its page, as DesktopAlertOpener does on a
 *   computer; a meeting alert joins the call. The app holds a tap that
 *   launched it until this listens.
 * - On launch and whenever the app comes back to the front, the app checks
 *   in for alerts (lib/ios/alerts-client.ts).
 */
export function IosAppBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const signingIn = pathname === '/login' || pathname.startsWith('/desktop/');

  React.useEffect(() => {
    if (!inIosApp()) return;

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const target = anchor.target.toLowerCase();
      if (!target || target === '_self' || target === '_top' || target === '_parent') return;
      if (anchor.hasAttribute('download')) return;
      const to = sameOrigin(anchor.href);
      if (!to) return;
      event.preventDefault();
      followHere(to);
    };
    document.addEventListener('click', onClick, true);

    const original = window.open;
    window.open = function open(url?: string | URL, target?: string, features?: string) {
      const to = url ? sameOrigin(String(url)) : null;
      if (to) {
        followHere(to);
        return null;
      }
      return original.call(window, url, target, features);
    };

    return () => {
      document.removeEventListener('click', onClick, true);
      window.open = original;
    };
  }, []);

  React.useEffect(() => {
    if (!inIosApp()) return;
    const openInApp = (path: string) => {
      const to = sameOrigin(path);
      if (to) followHere(to, (href) => router.push(href));
    };
    return (
      onIosEvent('PushNotifications', 'pushNotificationActionPerformed', (data) => {
        const action = data as {
          actionId?: unknown;
          notification?: { data?: { url?: unknown } };
        } | null;
        if (action?.actionId !== 'tap') return;
        const path = action.notification?.data?.url;
        if (!isInAppAlertPath(path)) return;
        if (path.startsWith('/go/meeting?')) void joinMeeting(path, openInApp);
        else if (path.startsWith('/go/')) window.location.assign(path);
        else openInApp(path);
      }) ?? undefined
    );
  }, [router]);

  React.useEffect(() => {
    if (!inIosApp() || signingIn) return;
    const checkIn = () => {
      if (document.visibilityState === 'visible') void checkInIosAlerts();
    };
    checkIn();
    document.addEventListener('visibilitychange', checkIn);
    return () => document.removeEventListener('visibilitychange', checkIn);
  }, [signingIn]);

  return null;
}
