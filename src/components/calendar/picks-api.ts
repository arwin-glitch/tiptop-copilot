import type { PickCreateInput, PickView } from '@/lib/booking/picks';

/**
 * The Calendar's calls for Pick times (/api/booking/picks). Each answers
 * `{ ok: true, value }` or `{ ok: false, message }` with the server's plain
 * words, like calendar-api.ts.
 */

export type PickApiResult<T> =
  { ok: true; value: T } | { ok: false; message: string; code?: string };

async function call<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<PickApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as
      | ({ ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>)
      | null;
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        message: json?.error?.message ?? 'Something went wrong. Try again.',
        code: json?.error?.code,
      };
    }
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, message: 'Kraken could not be reached. Check the connection.' };
  }
}

/** GET /api/booking/picks: the open picks (and whether picking can work at all). */
export interface PickListAnswer {
  /** False until the booking_picks migration is run: show "Pick times needs a database update." */
  available: boolean;
  /** False when the booking link has no settings row (no slug): point at the Booking tab. */
  linkReady: boolean;
  slug: string | null;
  /** Open, unexpired picks with a range in the window, newest first. */
  picks: PickView[];
}

export function fetchPicks(range: { from?: string; to?: string } = {}) {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const query = params.toString();
  return call<PickListAnswer>('GET', `/api/booking/picks${query ? `?${query}` : ''}`);
}

/** POST /api/booking/picks: the pick made, its absolute link and the clipboard's text and HTML. */
export interface CreatedPickAnswer {
  id: string;
  url: string;
  text: string;
  html: string;
  expiresAt: string;
  pick: PickView;
  /** Some times are held for someone else already: they are not offered. */
  warning: string | null;
}

export function createPick(input: PickCreateInput) {
  return call<CreatedPickAnswer>('POST', '/api/booking/picks', input);
}

/** POST /api/booking/picks/<id>/copy: the same link and text again, while the pick is open. */
export interface CopiedPickAnswer {
  url: string;
  text: string;
  html: string;
  expiresAt: string;
}

export function copyPickAgain(id: string) {
  return call<CopiedPickAnswer>('POST', `/api/booking/picks/${encodeURIComponent(id)}/copy`);
}

/** POST /api/booking/picks/<id>/revoke: the link closes and its times are no longer held. */
export function revokePick(id: string) {
  return call<{ pick: PickView }>('POST', `/api/booking/picks/${encodeURIComponent(id)}/revoke`);
}
