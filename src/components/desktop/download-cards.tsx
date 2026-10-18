'use client';

import * as React from 'react';
import { Download, Laptop, Monitor } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import {
  compareVersions,
  DESKTOP_INSTALLERS,
  FIRST_SELF_UPDATING_VERSION,
  formatInstallerSize,
  updatesItself,
  whereToCheckForUpdates,
  type DesktopRelease,
  type InstallerPlatform,
} from '@/lib/desktop/shared';
import { useDesktopApp } from '@/lib/desktop/use-desktop-app';
import { SecuritySteps } from './security-steps';

type Device = InstallerPlatform | 'phone' | 'other';

function detectDevice(): Device {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const ua = nav.userAgent;
  // iPadOS asks for desktop sites as a Mac; its touch points give it away.
  if (
    nav.userAgentData?.mobile ||
    /iPhone|iPad|iPod|Android/i.test(ua) ||
    (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)
  ) {
    return 'phone';
  }
  const platform = nav.userAgentData?.platform ?? '';
  if (/mac/i.test(platform) || /Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/win/i.test(platform) || /Windows/.test(ua)) return 'windows';
  return 'other';
}

const noSubscribe = () => () => {};

const CARDS: Record<
  InstallerPlatform,
  { name: string; requirement: string; action: string; label: string }
> = {
  mac: {
    name: 'Mac',
    requirement: 'macOS 13 or newer.',
    action: 'Download for Mac',
    label: 'The Mac app',
  },
  windows: {
    name: 'Windows',
    requirement: 'Windows 10 or 11.',
    action: 'Download for Windows',
    label: 'The Windows app',
  },
};

function installer(release: DesktopRelease, platform: InstallerPlatform) {
  // Unknown is not "missing": the lookup was refused, and the download route
  // still finds the file by its stable name.
  if (release.state === 'unknown') return { available: true, bytes: null };
  if (release.state === 'none') return { available: false, bytes: null };
  const asset = release.installers[platform];
  return { available: Boolean(asset), bytes: asset?.bytes ?? null };
}

function DownloadCard({
  platform,
  release,
  thisComputer,
}: {
  platform: InstallerPlatform;
  release: DesktopRelease;
  thisComputer: boolean;
}) {
  const card = CARDS[platform];
  const { available, bytes } = installer(release, platform);
  const headingId = `download-${platform}`;
  const size = bytes ? formatInstallerSize(bytes) : '';
  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
          >
            {platform === 'mac' ? <Laptop className="size-4" /> : <Monitor className="size-4" />}
          </span>
          <div>
            <CardTitle as="h2" id={headingId} className="text-title font-serif">
              {card.name}
            </CardTitle>
            <p className="text-sm text-[var(--fg-muted)]">{card.requirement}</p>
          </div>
        </div>
        {thisComputer ? <Badge tone="ok">This computer</Badge> : null}
      </CardHeader>
      <CardContent>
        {available ? (
          <>
            <Button asChild variant="primary">
              {/* A plain link: the route streams the file, or sends this page
                  back with a notice when there is nothing to download. */}
              <a href={`/api/desktop/download/${platform}`}>
                <Download aria-hidden="true" />
                {card.action}
              </a>
            </Button>
            <p className="mt-2 text-xs text-[var(--fg-subtle)]">
              {DESKTOP_INSTALLERS[platform]}
              {size ? ` · ${size}` : ''}
            </p>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled>
              Coming soon
            </Button>
            <p className="mt-2 text-xs text-[var(--fg-subtle)]">
              The first version is on its way. Check back soon.
            </p>
          </>
        )}
        <SecuritySteps platform={platform} />
      </CardContent>
    </Card>
  );
}

/**
 * The two installers, the steps an unsigned app needs the first time, and,
 * inside the desktop app, whether a newer version is out. Which computer this
 * is only adds a badge: the cards never swap places.
 */
export function DownloadCards({
  release,
  unavailable,
  failed,
  serverVersion,
}: {
  release: DesktopRelease;
  unavailable: InstallerPlatform | null;
  failed: InstallerPlatform | null;
  serverVersion: string | null;
}) {
  const device = React.useSyncExternalStore(noSubscribe, detectDevice, () => 'other' as Device);
  const appVersion = useDesktopApp(serverVersion);
  const latest =
    release.state === 'ready'
      ? release.version
      : release.state === 'unknown'
        ? release.version
        : null;
  const newer = appVersion && latest && compareVersions(latest, appVersion) > 0 ? latest : null;
  // From 0.2.0 the app installs its own updates; an older one needs one more download.
  const selfUpdating = updatesItself(appVersion);
  const oldApp = appVersion !== null && !selfUpdating;
  const firstSelfUpdating = newer && oldApp && updatesItself(newer) ? newer : null;
  // In a browser, the version on offer decides: until a self-updating one is
  // published (or when it is not known), the claim carries its version.
  const offersSelfUpdating = selfUpdating || updatesItself(latest);

  return (
    <div className="space-y-6">
      {unavailable ? (
        <Notice tone="warn">{CARDS[unavailable].label} isn’t ready yet. Check back soon.</Notice>
      ) : null}
      {failed ? (
        <Notice tone="warn">The download didn’t start. Try again in a minute.</Notice>
      ) : null}
      {device === 'phone' ? (
        <Notice>Open this page on your Mac or PC to download the app.</Notice>
      ) : null}

      <div data-tour="download-apps" className="grid gap-4 lg:grid-cols-2">
        <DownloadCard platform="mac" release={release} thisComputer={device === 'mac'} />
        <DownloadCard platform="windows" release={release} thisComputer={device === 'windows'} />
      </div>

      <Card data-tour="download-more">
        <CardContent className="space-y-4 pt-4 text-sm">
          <section aria-labelledby="download-sign-in">
            <h2 id="download-sign-in" className="text-sm font-semibold">
              Signing in
            </h2>
            <p className="mt-1 text-[var(--fg-muted)]">
              The first time, the app opens your web browser so you can sign in with Google. After
              that it stays signed in.
            </p>
          </section>

          {appVersion ? null : (
            <section aria-labelledby="download-no-steps">
              <h2 id="download-no-steps" className="text-sm font-semibold">
                Rather skip the security steps?
              </h2>
              <p className="mt-1 text-[var(--fg-muted)]">
                Install from Chrome: open copilot.tiptop.vc in Chrome, click the install icon at the
                right end of the address bar, then Install. On a Mac with Safari: File, then Add to
                Dock.
              </p>
            </section>
          )}

          <section aria-labelledby="download-updates">
            <h2 id="download-updates" className="text-sm font-semibold">
              Updates
            </h2>
            {firstSelfUpdating ? (
              <Notice className="mt-2">
                Download {firstSelfUpdating} once - after that it updates itself.
              </Notice>
            ) : newer && oldApp ? (
              <Notice className="mt-2">
                Version {newer} is ready. Download it again to update.
              </Notice>
            ) : newer ? (
              <Notice className="mt-2">
                Version {newer} is out. The app installs it by itself, or use Check for Updates… to
                get it now.
              </Notice>
            ) : appVersion ? (
              <p className="mt-1 text-[var(--fg)]">
                You’re using the desktop app, version {appVersion}.
              </p>
            ) : null}
            {oldApp ? (
              <p className="mt-1 text-[var(--fg-muted)]">
                The app always shows the latest Copilot, so most updates need nothing from you. To
                install a new app version, quit the app first (Mac: ⌘Q; Windows: right-click the
                tray icon, then Quit), then download it again and install it over the old one. From
                version {FIRST_SELF_UPDATING_VERSION} the app updates itself.
              </p>
            ) : offersSelfUpdating ? (
              <p className="mt-1 text-[var(--fg-muted)]">
                The app always shows the latest Copilot and installs its own updates: when a new
                version is ready, it asks to restart, which takes about 10 to 20 seconds. To look
                now, use Check for Updates… {whereToCheckForUpdates(appVersion ?? latest)}.
              </p>
            ) : (
              <p className="mt-1 text-[var(--fg-muted)]">
                The app always shows the latest Copilot, so most updates need nothing from you. From
                version {FIRST_SELF_UPDATING_VERSION} the app updates itself: when a new version is
                ready, it asks to restart, which takes about 10 to 20 seconds. To look now, use
                Check for Updates… {whereToCheckForUpdates(appVersion ?? latest)}.
              </p>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
