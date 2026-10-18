'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  FIRST_SELF_UPDATING_VERSION,
  updatesItself,
  whereToCheckForUpdates,
} from '@/lib/desktop/shared';
import { useDesktopApp } from '@/lib/desktop/use-desktop-app';

/**
 * Settings > Preferences: the desktop app. In a browser, where to get it;
 * inside the app, which version this is and how it updates. From 0.2.0 the
 * app installs its own updates; an older one is pointed to /download once
 * more, with the newest version when the server looked it up.
 */
export function DesktopAppSetting({
  serverVersion = null,
  newestVersion = null,
}: {
  serverVersion?: string | null;
  newestVersion?: string | null;
}) {
  const version = useDesktopApp(serverVersion);
  if (version && updatesItself(version)) {
    return (
      <div>
        <p className="text-sm font-medium">Desktop app</p>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          You’re using the desktop app, version {version}. It installs its own updates: when a new
          version is ready, it asks to restart.
        </p>
        <p className="mt-1 text-xs text-[var(--fg-subtle)]">
          To look now, use Check for Updates… {whereToCheckForUpdates(version)}.
        </p>
      </div>
    );
  }
  if (version) {
    const oneMore = newestVersion && updatesItself(newestVersion) ? newestVersion : null;
    return (
      <div>
        <p className="text-sm font-medium">Desktop app</p>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          You’re using the desktop app, version {version}.
        </p>
        {oneMore ? (
          <>
            <p className="mt-1 text-sm text-[var(--fg)]">
              Download {oneMore} once - after that it updates itself.
            </p>
            <Button asChild variant="secondary" size="sm" className="mt-3">
              <Link href="/download">Get version {oneMore}</Link>
            </Button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              From version {FIRST_SELF_UPDATING_VERSION} the app updates itself.
            </p>
            <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
              <Link href="/download">Check for a new version</Link>
            </Button>
          </>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className="text-sm font-medium">Desktop app</p>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        Copilot in its own window, with an icon in your Dock or taskbar.
      </p>
      <Button asChild variant="secondary" size="sm" className="mt-3">
        <Link href="/download">Get the desktop app</Link>
      </Button>
    </div>
  );
}
