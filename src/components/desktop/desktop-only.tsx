'use client';

import type * as React from 'react';
import { useDesktopApp } from '@/lib/desktop/use-desktop-app';
import { useIosApp } from '@/lib/ios/use-ios-app';

/** Rendered only inside the desktop app. */
export function DesktopOnly({
  children,
  serverVersion = null,
}: {
  children: React.ReactNode;
  serverVersion?: string | null;
}) {
  return useDesktopApp(serverVersion) ? children : null;
}

/**
 * Rendered only inside an app, the desktop app or the iPhone app: both sign
 * in through the browser. `iosServerVersion` is the iPhone app's hint from
 * the server render (iosAppHint).
 */
export function InAppOnly({
  children,
  serverVersion = null,
  iosServerVersion = null,
}: {
  children: React.ReactNode;
  serverVersion?: string | null;
  iosServerVersion?: string | null;
}) {
  const desktop = useDesktopApp(serverVersion);
  const ios = useIosApp(iosServerVersion);
  return desktop || ios ? children : null;
}

/**
 * Rendered everywhere except the desktop and iPhone apps, which show
 * `fallback` instead: for links an app's window cannot complete, such as
 * Google's consent screens.
 */
export function WebOnly({
  children,
  fallback = null,
  serverVersion = null,
  iosServerVersion = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  serverVersion?: string | null;
  iosServerVersion?: string | null;
}) {
  const desktop = useDesktopApp(serverVersion);
  const ios = useIosApp(iosServerVersion);
  return desktop || ios ? fallback : children;
}
