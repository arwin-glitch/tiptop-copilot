'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  DESKTOP_ALERT_OPEN_EVENT,
  desktopAlertsShell,
  desktopAppVersion,
  isInAppAlertPath,
} from '@/lib/desktop/shared';

/**
 * Clicking a desktop alert (0.4.0 and newer): the shell brings the main
 * window forward and fires DESKTOP_ALERT_OPEN_EVENT with the alert's in-app
 * path, and this follows it as if a link to it had been clicked. A real
 * click on a hidden link, rather than router.push, so whatever guards links
 * on the page still applies: a campaign that is sending asks "Leave while
 * sending?" first. Meeting links (/go/…) are a full navigation, which the
 * shell sends on to the system browser. Anything that is not an in-app path
 * is ignored.
 *
 * Mounted once, in the root layout; renders nothing.
 */
export function DesktopAlertOpener() {
  const router = useRouter();

  React.useEffect(() => {
    if (!desktopAlertsShell(desktopAppVersion())) return;
    const open = (event: Event) => {
      const path = (event as CustomEvent<unknown>).detail;
      if (!isInAppAlertPath(path)) return;
      if (path.startsWith('/go/')) {
        window.location.assign(path);
        return;
      }
      const link = document.createElement('a');
      link.href = path;
      link.hidden = true;
      link.addEventListener('click', (click) => {
        if (click.defaultPrevented) return;
        click.preventDefault();
        router.push(path);
      });
      document.body.append(link);
      link.click();
      link.remove();
    };
    window.addEventListener(DESKTOP_ALERT_OPEN_EVENT, open);
    return () => window.removeEventListener(DESKTOP_ALERT_OPEN_EVENT, open);
  }, [router]);

  return null;
}
