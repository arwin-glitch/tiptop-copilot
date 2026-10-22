import { processWide } from '@/lib/util/process-state';

/**
 * A brake on anonymous traffic to the public board, for the proxy. The board
 * is the first public, unauthenticated surface served by the same process as
 * Copilot, so a flood of page or image requests must not be able to take
 * Copilot down with it. Pure apart from its in-process counters (no
 * `server-only` imports, so the proxy can use it), and keyed on the caller's
 * address the same way lib/security/client-address.ts reads it.
 *
 * An abuse brake only: a shared or wrong key can slow people down, never let
 * anyone in. Link-preview images cost far more to draw than a page, so they
 * have their own, smaller allowance.
 */

export const BOARD_WINDOW_MS = 60_000;
export const BOARD_PAGE_LIMIT = 120;
export const BOARD_IMAGE_LIMIT = 20;
/** Above this many counters, spent ones are dropped (at most once a second). */
const PRUNE_ABOVE = 5_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const state = processWide('jobs-board-rate-limit', () => ({
  buckets: new Map<string, Bucket>(),
  prunedAt: 0,
}));

/** Test hook. */
export function resetBoardRateLimit(): void {
  state.buckets.clear();
  state.prunedAt = 0;
}

/**
 * The caller's address: Cloudflare's CF-Connecting-IP (Render serves through
 * Cloudflare, which overwrites it), else the last X-Forwarded-For hop (the
 * first is whatever the client wrote), else X-Real-IP. An IPv6 address counts
 * by its /64, which one party controls.
 */
export function boardClientKey(headers: { get(name: string): string | null }): string {
  const edge = headers.get('cf-connecting-ip')?.trim();
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const address = (edge || hops.at(-1) || headers.get('x-real-ip')?.trim() || 'unknown')
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
    .slice(0, 64);
  if (!address.includes(':') || /^::ffff:\d/.test(address)) return address;
  return `${address.split(':').slice(0, 4).join(':')}::/64`;
}

/**
 * Count one board request; false when this address is over its allowance for
 * the current minute (the proxy answers 429).
 */
export function boardRequestAllowed(
  headers: { get(name: string): string | null },
  pathname: string,
  now: number = Date.now(),
): boolean {
  const image = pathname.endsWith('/opengraph-image');
  const key = `${image ? 'image' : 'page'}|${boardClientKey(headers)}`;
  const max = image ? BOARD_IMAGE_LIMIT : BOARD_PAGE_LIMIT;
  const existing = state.buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    if (state.buckets.size > PRUNE_ABOVE && now - state.prunedAt >= 1_000) {
      state.prunedAt = now;
      for (const [k, bucket] of state.buckets) if (bucket.resetAt <= now) state.buckets.delete(k);
    }
    state.buckets.set(key, { count: 1, resetAt: now + BOARD_WINDOW_MS });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}
