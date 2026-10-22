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
 *
 * Only addresses shaped like the board's own pages are ever routed to a page
 * (`isBoardPath`): home, /companies, /<company>, /<company>/<role>, a role's
 * link-preview image, the sitemap and robots.txt. Anything else (a scanner's
 * /.env or /wp-login.php, a three-level path) is a plain 404 from the proxy,
 * so it never renders a page or reads the database.
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
  /** Not the board host: Copilot's own routing goes on. */
  | { kind: 'pass' }
  /** The board host's own files (Next assets, icons, preview images): served as they are, no session. */
  | { kind: 'serve' }
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'redirect'; pathname: string }
  | { kind: 'not_found' };

function cleanHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]!.trim().toLowerCase();
  // Strip a port; an IPv6 literal keeps its brackets. Then one trailing dot:
  // "jobs.tiptop.vc." is the same host as "jobs.tiptop.vc".
  const host = (
    first.startsWith('[') ? first.replace(/\]:\d+$/, ']') : first.replace(/:\d+$/, '')
  ).replace(/\.$/, '');
  return /^[a-z0-9.[\]:-]{1,253}$/.test(host) ? host : null;
}

/** One level of a board address: a company or role slug (lib/jobs-board/slug.ts). */
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,100}$/;
/** The board's own files at its root. */
const BOARD_FILES = new Set(['/sitemap.xml', '/robots.txt', '/opengraph-image']);
const OG_IMAGE = 'opengraph-image';

/**
 * Whether a path, relative to the board's root, is one the board serves:
 * `/`, `/companies`, `/<company>`, `/<company>/<role>`, a role's
 * `/<company>/<role>/opengraph-image`, and the sitemap, robots.txt and home
 * link-preview image. A trailing slash is allowed.
 */
export function isBoardPath(path: string): boolean {
  if (path === '' || path === '/') return true;
  if (BOARD_FILES.has(path)) return true;
  if (!path.startsWith('/')) return false;
  const parts = path.slice(1).replace(/\/$/, '').split('/');
  if (parts.length === 3 && parts[2] === OG_IMAGE) parts.pop();
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => SEGMENT.test(part) && part !== OG_IMAGE);
}

/** A role's or the home page's link-preview image at its internal /jobs-host address. */
function isInternalOgImage(pathname: string): boolean {
  if (pathname === `${JOBS_HOST_ROUTE}/${OG_IMAGE}`) return true;
  const parts = pathname.slice(JOBS_HOST_ROUTE.length + 1).split('/');
  return (
    pathname.startsWith(`${JOBS_HOST_ROUTE}/`) &&
    parts.length === 3 &&
    parts[2] === OG_IMAGE &&
    SEGMENT.test(parts[0]!) &&
    SEGMENT.test(parts[1]!)
  );
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

/**
 * The hosts a request names: its Host header (Render routes by it and passes
 * it on unchanged). X-Forwarded-Host is a header any client can write, so it
 * counts only where JOBS_BOARD_TRUST_FORWARDED_HOST=true (the e2e server,
 * which has no DNS for jobs.tiptop.vc). Even then it can only add the board,
 * never take it away: a request to jobs.tiptop.vc always gets the board.
 */
export function requestHosts(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  const values = [headers.get('host')];
  if (env.JOBS_BOARD_TRUST_FORWARDED_HOST === 'true') values.push(headers.get('x-forwarded-host'));
  for (const value of values) {
    const host = cleanHost(value);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

function isInternal(pathname: string): boolean {
  return pathname === JOBS_HOST_ROUTE || pathname.startsWith(`${JOBS_HOST_ROUTE}/`);
}

export function routeBoardHost(
  pathname: string,
  requested: readonly string[],
  hosts: readonly string[],
): HostDecision {
  const onBoardHost = requested.some((host) => hosts.includes(host));
  if (!onBoardHost) return isInternal(pathname) ? { kind: 'not_found' } : { kind: 'pass' };

  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/__nextjs') ||
    PASS_THROUGH.has(pathname)
  ) {
    return { kind: 'serve' };
  }
  // The pages' og:image addresses are their internal ones (Next writes them
  // from the route), so those images, and nothing else internal, are served.
  if (isInternalOgImage(pathname)) return { kind: 'serve' };
  if (isInternal(pathname)) return { kind: 'not_found' };
  if (pathname === '/jobs' || pathname === '/jobs/') return { kind: 'redirect', pathname: '/' };
  if (pathname.startsWith('/jobs/')) {
    const short = pathname.slice(5);
    return isBoardPath(short) ? { kind: 'redirect', pathname: short } : { kind: 'not_found' };
  }
  if (!isBoardPath(pathname)) return { kind: 'not_found' };
  return {
    kind: 'rewrite',
    pathname: pathname === '/' ? JOBS_HOST_ROUTE : `${JOBS_HOST_ROUTE}${pathname}`,
  };
}

/**
 * The board at Copilot's own /jobs: a path there that the board does not
 * serve (`/jobs/a/b/c`, `/jobs/.env`) answers 404 before any page renders.
 * Null for paths outside /jobs.
 */
export function isCopilotBoardPath(pathname: string): boolean | null {
  if (pathname !== '/jobs' && !pathname.startsWith('/jobs/')) return null;
  return isBoardPath(pathname.slice(5));
}
