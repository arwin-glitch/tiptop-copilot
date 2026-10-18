'use client';

import * as React from 'react';
import { desktopAppVersion } from './shared';

const noSubscribe = () => () => {};

/**
 * The desktop app's version while this page is open inside it, else null.
 *
 * The server renders with `serverVersion` (the shell's cookie, read by
 * desktopVersionHint) so a page opened in the app does not flash its browser
 * layout; the client then reads the shell's own global. The global never
 * changes while a page is open, so there is nothing to subscribe to.
 */
export function useDesktopApp(serverVersion: string | null = null): string | null {
  return React.useSyncExternalStore(noSubscribe, desktopAppVersion, () => serverVersion);
}
