/**
 * The Events tab's JSON calls (D-075, WS5), in one place: the body on
 * success, the server's own message on failure (written to be shown), and a
 * plain sentence when the server could not be reached.
 *
 * Endpoints, by owner:
 *   WS1  POST   /api/events                       create            (in the contract commit)
 *   WS1  POST   /api/events/[id]/draft/ops         SEO text           (in the contract commit)
 *   WS1  PATCH  /api/events/[id]                   slug, visibility, password
 *   WS1  DELETE /api/events/[id]                   delete a draft
 *   WS1  POST   /api/events/[id]/duplicate         { shiftDays, asTemplate? } → { id }
 *   WS1  POST   /api/events/[id]/unpublish
 *   WS1  POST   /api/events/[id]/cancel            { message }
 *   WS1  POST   /api/events/[id]/archive           (not in the spec's route list: see
 *                                                   the integration notes)
 *   WS5  POST   /api/events/[id]/campaign          draft a message → { campaignId }
 *   WS5  PUT    /api/events/[id]/campaign/settings reminder schedule, sender
 *
 * A route that is not there yet (404 with no JSON body) reads as "still being
 * built", never as a broken page.
 */

export type EventCallResult<T> = { ok: true; data: T } | { ok: false; message: string };

export const STILL_BEING_BUILT = 'This part of Events is still being built. Nothing was changed.';

export async function eventCall<T>(url: string, init?: RequestInit): Promise<EventCallResult<T>> {
  try {
    const res = await fetch(url, init);
    const json = (await res.json().catch(() => null)) as
      (T & { error?: { message?: string } }) | null;
    if (!json) {
      return {
        ok: false,
        message:
          res.status === 404 || res.status === 405
            ? STILL_BEING_BUILT
            : 'That did not work. Try again.',
      };
    }
    if (!res.ok)
      return { ok: false, message: json.error?.message ?? 'That did not work. Try again.' };
    return { ok: true, data: json };
  } catch {
    return { ok: false, message: 'Could not reach Copilot. Check the connection and try again.' };
  }
}

export const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const enc = encodeURIComponent;

export const eventsApi = {
  create: (body: Record<string, unknown>) =>
    eventCall<{ id: string; slug: string }>('/api/events', jsonInit('POST', body)),
  patch: (id: string, patch: Record<string, unknown>) =>
    eventCall<{ event?: unknown }>(`/api/events/${enc(id)}`, jsonInit('PATCH', patch)),
  remove: (id: string) =>
    eventCall<Record<string, unknown>>(`/api/events/${enc(id)}`, { method: 'DELETE' }),
  duplicate: (id: string, body: { shiftDays: number; asTemplate?: boolean }) =>
    eventCall<{ id: string }>(`/api/events/${enc(id)}/duplicate`, jsonInit('POST', body)),
  unpublish: (id: string) =>
    eventCall<Record<string, unknown>>(`/api/events/${enc(id)}/unpublish`, jsonInit('POST', {})),
  cancel: (id: string, message: string | null) =>
    eventCall<Record<string, unknown>>(
      `/api/events/${enc(id)}/cancel`,
      jsonInit('POST', { message }),
    ),
  archive: (id: string) =>
    eventCall<Record<string, unknown>>(`/api/events/${enc(id)}/archive`, jsonInit('POST', {})),
  draftOps: (id: string, body: { baseVersion: number; ops: unknown[] }) =>
    eventCall<{
      version: number;
      applied: string[];
      conflicts: { message: string }[];
    }>(`/api/events/${enc(id)}/draft/ops`, jsonInit('POST', body)),
  draftMessage: (id: string, body: Record<string, unknown>) =>
    eventCall<{
      campaignId: string;
      name: string;
      added: number;
      left: { unsubscribed: number; noEmail: number; invalid: number; overLimit: number };
      notLive: boolean;
    }>(`/api/events/${enc(id)}/campaign`, jsonInit('POST', body)),
  messageSettings: (
    id: string,
    body: { reminderOffsetsMinutes?: number[]; sender?: 'nick' | 'arwin' },
  ) =>
    eventCall<{ comms: unknown }>(
      `/api/events/${enc(id)}/campaign/settings`,
      jsonInit('PUT', body),
    ),
};

/** Where a campaign draft is reviewed and sent: the existing campaign page. */
export function campaignHref(campaignId: string): string {
  return `/fund-ii/campaigns/${enc(campaignId)}`;
}

/** A short id for a draft op (ops.ts: ^[\w-]+$, up to 64). */
export function opId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
