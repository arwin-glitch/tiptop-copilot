import type { BadgeProps } from '@/components/ui/badge';
import type { EventGuestSource, EventGuestStatus } from '@/lib/types/domain';

/** Shared by the host's guest table, drawer and dialogs (client). */

export const STATUS_LABEL: Record<EventGuestStatus, string> = {
  going: 'Going',
  pending: 'Pending',
  waitlist: 'Waitlist',
  invited: 'Invited',
  maybe: 'Maybe',
  not_going: 'Not going',
  declined: 'Declined',
};

export const STATUS_TONE: Record<EventGuestStatus, NonNullable<BadgeProps['tone']>> = {
  going: 'ok',
  pending: 'info',
  waitlist: 'warn',
  invited: 'neutral',
  maybe: 'outline',
  not_going: 'neutral',
  declined: 'danger',
};

export const SOURCE_LABEL: Record<EventGuestSource, string> = {
  invite: 'Invited',
  public: 'Public form',
  request: 'Asked for an invite',
  import: 'CSV import',
  host: 'Added by host',
  walk_in: 'Walk-in',
  plus_one: 'Plus-one',
};

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  error?: { code: string; message: string };
  data: T | null;
}

/** JSON request to a signed-in /api/events route. */
export async function api<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as
      (T & { ok?: boolean; error?: ApiResult['error'] }) | null;
    if (!json)
      return {
        ok: false,
        error: { code: 'internal', message: 'Something went wrong. Try again.' },
        data: null,
      };
    if (!json.ok) {
      return {
        ok: false,
        error: json.error ?? { code: 'internal', message: 'That did not work.' },
        data: null,
      };
    }
    return { ok: true, data: json };
  } catch {
    return {
      ok: false,
      error: { code: 'internal', message: 'You seem to be offline. Try again.' },
      data: null,
    };
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Jan 25, 6:42 PM" in the event's zone. */
export function shortStamp(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}
