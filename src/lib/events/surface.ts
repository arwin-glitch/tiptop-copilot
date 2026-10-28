/**
 * The PUBLIC SURFACE: pages outsiders open on Kraken's own origin — event
 * pages and their guest/editor/staff entries (/e/*), and the booking page
 * (/meet/*, D-074). proxy.ts marks these requests with a header the root
 * layout reads, so guests never get Kraken's chrome: no service-worker
 * registration (and no offline page), no Kraken theme script, no desktop
 * title bar or alert opener.
 *
 * /e/* pages also get their own strict, per-request nonce CSP instead of
 * Kraken's: outsider-authored content renders there next to Nick's session
 * cookies, so a script that is not ours must never run.
 *
 * Pure: imported by proxy.ts (no server-only, no env() — process.env read
 * directly, as proxy.ts does) and by the root layout.
 */

/** Request header proxy.ts sets on public-surface requests (and strips from every other). */
export const SURFACE_HEADER = 'x-tiptop-surface';
/** Request header carrying the per-request CSP nonce on /e/* pages. */
export const NONCE_HEADER = 'x-nonce';

/** Whether a path is (or is under) a prefix, segment-exact: /events is not /e. */
export function underPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Event pages and everything under them, pages and API alike. */
export function isEventPublicPath(pathname: string): boolean {
  return underPath(pathname, '/e') || underPath(pathname, '/api/e');
}

/** Pages where Kraken's chrome must not appear. */
export function isPublicSurfacePath(pathname: string): boolean {
  return underPath(pathname, '/e') || underPath(pathname, '/meet');
}

/** /e/* pages (not their API) get the nonce CSP. */
export function wantsEventCsp(pathname: string): boolean {
  return underPath(pathname, '/e');
}

/**
 * Paths under /e that must never be indexed or followed whatever the event:
 * edit and staff entries, personal invites and check-in QR landings.
 * (/e/<slug> itself says noindex in its own metadata unless the event is
 * public and published.)
 */
export function isPrivateEventPath(pathname: string): boolean {
  return (
    underPath(pathname, '/e/edit') ||
    underPath(pathname, '/e/checkin') ||
    /^\/e\/[^/]+\/(i|c)(\/|$)/.test(pathname)
  );
}

/** The staff door list may use the camera (in-app QR scanner, v1 nice). */
export function allowsCamera(pathname: string): boolean {
  return underPath(pathname, '/e/checkin');
}

/** Third-party frames an embed block may load (on click), by origin. */
export const EVENT_FRAME_ORIGINS = [
  'https://www.google.com',
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.loom.com',
  'https://open.spotify.com',
] as const;

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The Supabase project origin (media, signed URLs), or null when not configured. */
export function supabaseOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export interface EventCspOptions {
  nonce: string;
  supabaseUrl?: string | null;
  turnstile?: boolean;
  dev?: boolean;
}

/**
 * The /e/* Content-Security-Policy. Next.js reads the nonce from this header
 * on the request and applies it to its own scripts; with 'strict-dynamic'
 * nothing else runs. Pages using it must render dynamically.
 */
export function eventCsp({
  nonce,
  supabaseUrl,
  turnstile = false,
  dev = false,
}: EventCspOptions): string {
  const supabase = supabaseOrigin(supabaseUrl);
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (turnstile) script.push(TURNSTILE_ORIGIN);
  // React uses eval in development only (stack reconstruction).
  if (dev) script.push("'unsafe-eval'");
  const frames: string[] = [...EVENT_FRAME_ORIGINS];
  if (turnstile) frames.push(TURNSTILE_ORIGIN);
  const connect = ["'self'"];
  if (supabase) connect.push(supabase);
  // The dev server's hot reload socket.
  if (dev) connect.push('ws:', 'wss:');
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabase ? ` ${supabase}` : ''}`,
    `media-src 'self'${supabase ? ` ${supabase}` : ''}`,
    "font-src 'self'",
    `frame-src ${frames.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** A fresh nonce: 128 random bits, base64. Web Crypto, so it works in any runtime. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
