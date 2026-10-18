import 'server-only';
import { cookies } from 'next/headers';
import { DESKTOP_COOKIE, parseDesktopVersion } from './shared';

/**
 * The desktop app's version from the cookie its shell sets, for a server
 * render. A layout hint only, like the global it mirrors: never a reason to
 * grant anything. Absent on the very first page the app loads, which the
 * client then corrects (useDesktopApp).
 */
export async function desktopVersionHint(): Promise<string | null> {
  return parseDesktopVersion((await cookies()).get(DESKTOP_COOKIE)?.value);
}
