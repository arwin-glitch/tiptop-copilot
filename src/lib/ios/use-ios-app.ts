'use client';

import * as React from 'react';
import { iosAppVersion } from './shared';

const noSubscribe = () => () => {};

/**
 * The iPhone app's version while this page is open inside it, else null.
 *
 * The server renders with `serverVersion` (iosAppHint, from the request's
 * user agent) so a page opened in the app does not flash its browser layout;
 * the client then reads the page's own user agent, which never changes while
 * it is open.
 */
export function useIosApp(serverVersion: string | null = null): string | null {
  return React.useSyncExternalStore(noSubscribe, iosAppVersion, () => serverVersion);
}
