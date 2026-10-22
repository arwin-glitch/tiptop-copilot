/**
 * Serving the public job board at the root of its own host (jobs.tiptop.vc),
 * for the proxy. Pure: no Next imports, so it is tested on its own.
 *
 * On a board host every address is the board's: `/` is the board's home and
 * `/<company>/<role>` a role, rewritten to the `/jobs-host` pages (the same
 * pages as `/jobs`, with links written for the root). Copilot itself is never
 * reachable there: `/today` on the board host is just a company page that
 * does not exist. Old `/jobs/...` links redirect to the short form.
 *
 * On every other host `/jobs-host` is internal and answers 404, and the rest
 * is untouched (`/jobs` is the board on Copilot's own host).
 *
 * The board hosts: jobs.tiptop.vc, the host of JOBS_BOARD_URL when it is set,
 * and any extra in JOBS_BOARD_HOSTS (comma separated). Pointing a DNS CNAME
 * at the app is all a new host needs.
 */

export const JOBS_HOST_ROUTE = '/jobs-host';
export const DEFAULT_BOARD_HOST = 'jobs.tiptop.vc';

/** Files from /public the board's pages use, served as they are on a board host. */
const PASS_THROUGH = new Set([
  '/icon.svg',
  '/apple-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
]);

export type HostDecision =
  | { kind: 'pass' }
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'redirect'; pathname: string }
  | { kind: 'not_found' };

function cleanHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]!.trim().toLowerCase();
  // Strip a port; an IPv6 literal keeps its brackets.
  const host = first.startsWith('[') ? first.replace(/\]:\d+$/, ']') : first.replace(/:\d+$/, '');
  return /^[a-z0-9.[\]:-]{1,253}$/.test(host) ? host : null;
}

/** The hosts that serve the board at their root. */
export function boardHosts(env: Record<string, string | undefined>): string[] {
  const hosts = new Set<string>([DEFAULT_BOARD_HOST]);
  if (env.JOBS_BOARD_URL) {
    try {
      hosts.add(new URL(env.JOBS_BOARD_URL).hostname.toLowerCase());
    } catch {
      // A malformed value adds nothing.
    }
  }
  for (const extra of (env.JOBS_BOARD_HOSTS ?? '').split(',')) {
    const host = cleanHost(extra);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** The host a request was made to: the forwarded host when a proxy set one. */
export function requestHost(headers: { get(name: string): string | null }): string | null {
  return cleanHost(headers.get('x-forwarded-host')) ?? cleanHost(headers.get('host'));
}

function isInternal(pathname: string): boolean {
  return pathname === JOBS_HOST_ROUTE || pathname.startsWith(`${JOBS_HOST_ROUTE}/`);
}

export function routeBoardHost(
  pathname: string,
  host: string | null,
  hosts: readonly string[],
): HostDecision {
  const onBoardHost = host !== null && hosts.includes(host);
  if (!onBoardHost) return isInternal(pathname) ? { kind: 'not_found' } : { kind: 'pass' };

  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/__nextjs') ||
    PASS_THROUGH.has(pathname)
  ) {
    return { kind: 'pass' };
  }
  if (isInternal(pathname)) return { kind: 'not_found' };
  if (pathname === '/jobs' || pathname === '/jobs/') return { kind: 'redirect', pathname: '/' };
  if (pathname.startsWith('/jobs/')) return { kind: 'redirect', pathname: pathname.slice(5) };
  return {
    kind: 'rewrite',
    pathname: pathname === '/' ? JOBS_HOST_ROUTE : `${JOBS_HOST_ROUTE}${pathname}`,
  };
}
