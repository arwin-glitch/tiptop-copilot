import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { DESKTOP_COOKIE, parseDesktopVersion } from './shared';

/**
 * The desktop app's version from the cookie its shell sets, for a server
 * render. A layout hint only, like the global it mirrors: never a reason to
 * grant anything. Absent on the very first page the app loads, which the
 * client then corrects (useDesktopApp). Read once per server render.
 */
export const desktopVersionHint = cache(async (): Promise<string | null> =>
  parseDesktopVersion((await cookies()).get(DESKTOP_COOKIE)?.value),
);
