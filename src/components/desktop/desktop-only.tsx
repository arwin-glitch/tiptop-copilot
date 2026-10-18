'use client';

import type * as React from 'react';
import { useDesktopApp } from '@/lib/desktop/use-desktop-app';

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
 * Rendered everywhere except the desktop app, which shows `fallback` instead:
 * for links the app's window cannot complete, such as Google's consent
 * screens.
 */
export function WebOnly({
  children,
  fallback = null,
  serverVersion = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  serverVersion?: string | null;
}) {
  return useDesktopApp(serverVersion) ? fallback : children;
}
