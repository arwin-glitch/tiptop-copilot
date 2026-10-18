'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useDesktopApp } from '@/lib/desktop/use-desktop-app';

/**
 * Settings > Preferences: the desktop app. In a browser, where to get it;
 * inside the app, which version this is and where to look for a newer one.
 */
export function DesktopAppSetting({ serverVersion = null }: { serverVersion?: string | null }) {
  const version = useDesktopApp(serverVersion);
  return (
    <div>
      <p className="text-sm font-medium">Desktop app</p>
      {version ? (
        <>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            You’re using the desktop app, version {version}.
          </p>
          <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
            <Link href="/download">Check for a new version</Link>
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            Copilot in its own window, with an icon in your Dock or taskbar.
          </p>
          <Button asChild variant="secondary" size="sm" className="mt-3">
            <Link href="/download">Get the desktop app</Link>
          </Button>
        </>
      )}
    </div>
  );
}
