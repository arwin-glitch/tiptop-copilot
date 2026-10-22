import { ID_RE } from '@/lib/events/schema';

/**
 * The sync poll's query string, shared by the owners' and the outside
 * editor's sync routes and built by the client poller (sync.ts):
 *   ?since=<draft_version>&focus=<section id>&typing=1
 * Pure and isomorphic.
 */

export interface SyncQuery {
  since: number;
  presence: { focusedSectionId: string | null; typing: boolean };
}

export function readSyncQuery(params: URLSearchParams): SyncQuery {
  const since = Number(params.get('since') ?? '0');
  const focus = params.get('focus');
  return {
    since: Number.isSafeInteger(since) && since >= 0 ? since : 0,
    presence: {
      focusedSectionId: focus && ID_RE.test(focus) ? focus : null,
      typing: params.get('typing') === '1',
    },
  };
}

export function syncQueryString(query: SyncQuery): string {
  const params = new URLSearchParams({ since: String(query.since) });
  if (query.presence.focusedSectionId) params.set('focus', query.presence.focusedSectionId);
  if (query.presence.typing) params.set('typing', '1');
  return params.toString();
}
