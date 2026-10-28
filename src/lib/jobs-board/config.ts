import { DEFAULT_BOARD_HOST } from './host';

/**
 * Where the public board lives. Read from the environment directly (like the
 * proxy), so a page or the proxy can use it without the server config.
 *
 *   JOBS_BOARD_URL  The board's public address once its own host is live,
 *                   e.g. https://jobs.tiptop.vc. Canonical links, the
 *                   sitemap and Kraken's "View public board" button use it.
 *                   Unset: the board's address is APP_URL + /jobs.
 *   JOBS_BOARD_HOSTS Extra hosts that serve the board at their root (comma
 *                   separated); jobs.tiptop.vc always does.
 */

type Env = Record<string, string | undefined>;

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** JOBS_BOARD_URL as a clean base (no trailing slash), or null when unset or malformed. */
export function configuredBoardUrl(e: Env = process.env): string | null {
  const raw = e.JOBS_BOARD_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Kraken's own origin (APP_URL). */
export function appOrigin(e: Env = process.env): string {
  return origin(e.APP_URL) ?? origin(e.NEXT_PUBLIC_APP_URL) ?? 'http://localhost:3000';
}

/** The board's canonical base: JOBS_BOARD_URL, else Kraken's /jobs. */
export function boardPublicUrl(e: Env = process.env): string {
  return configuredBoardUrl(e) ?? `${appOrigin(e)}/jobs`;
}

/** The origin the board's own host serves, for its pages' absolute links and images. */
export function boardHostOrigin(e: Env = process.env): string {
  const configured = configuredBoardUrl(e);
  return configured ? new URL(configured).origin : `https://${DEFAULT_BOARD_HOST}`;
}

/** A path under the board ("/ledgerly/vp-sales-1a2b3c", or "" for home) as its canonical URL. */
export function canonicalBoardUrl(path: string, e: Env = process.env): string {
  const base = boardPublicUrl(e);
  return path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
}
