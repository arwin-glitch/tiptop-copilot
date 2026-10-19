'use client';

import { LogOut } from 'lucide-react';
import { signOutAction } from '@/app/actions/session';
import { Button } from '@/components/ui/button';
import { turnOffDesktopAlerts } from '@/lib/desktop/native';
import { desktopAlertsShell, desktopAppVersion, desktopFrame } from '@/lib/desktop/shared';
import { iosAlertsAvailable, turnOffIosAlerts } from '@/lib/ios/alerts-client';

/**
 * In the desktop app's main window (0.4.0 and newer), signing out turns
 * desktop alerts off on this computer first: the shell forgets its token and
 * the computer leaves the list. Three seconds at most, so a shell or server
 * that does not answer never holds up signing out.
 */
async function forgetThisComputer(): Promise<void> {
  if (!desktopAlertsShell(desktopAppVersion()) || !desktopFrame()) return;
  const quietly = async () => {
    const status = await turnOffDesktopAlerts();
    if (!status) return;
    await fetch('/api/push/desktop', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: status.device }),
    }).catch(() => null);
  };
  await Promise.race([quietly(), new Promise((resolve) => window.setTimeout(resolve, 3000))]);
}

/**
 * In the iPhone app, the same for this iPhone: its app alerts are turned off
 * first, so the next person to sign in on it does not get them. Three
 * seconds at most.
 */
async function forgetThisIphone(): Promise<void> {
  if (!iosAlertsAvailable()) return;
  await Promise.race([
    turnOffIosAlerts('sign_out'),
    new Promise((resolve) => window.setTimeout(resolve, 3000)),
  ]);
}

export function SignOutButton() {
  const leave = async () => {
    await forgetThisComputer();
    await forgetThisIphone();
    await signOutAction();
  };
  return (
    <form action={leave}>
      <Button type="submit" variant="ghost" size="sm" aria-label="Sign out">
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </form>
  );
}
