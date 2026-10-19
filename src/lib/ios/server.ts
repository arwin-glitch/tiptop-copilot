import 'server-only';
import { headers } from 'next/headers';
import { iosAppVersionFromUserAgent } from './shared';

/**
 * The iPhone app's version from this request's user agent, for a server
 * render, so a page opened in the app does not flash its browser layout. A
 * layout hint only, like desktopVersionHint: never a reason to grant
 * anything.
 */
export async function iosAppHint(): Promise<string | null> {
  return iosAppVersionFromUserAgent((await headers()).get('user-agent'));
}

/** Whether a request came from inside the iPhone app (a hint, as above). */
export function isIosAppRequest(request: Request): boolean {
  return iosAppVersionFromUserAgent(request.headers.get('user-agent')) !== null;
}
