import type { NextRequest } from 'next/server';
import { GUEST_TABS, type GuestFilter, type GuestTab } from '@/lib/events/guest-list';
import { eventsAuth, fail } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { exportGuests } from '@/lib/services/event-guests';
import type { EventGuestSource } from '@/lib/types/domain';

/**
 * GET /api/events/[id]/guests/export.csv — the guest list as CSV (D-075):
 * one row per guest and per plus-one, every answer, status and check-in per
 * session. ?kind=headcount gives the caterer's summary per session. The
 * table's filter (?tab, session, tag, source, q) narrows it. The UI asks for
 * a confirmation first (?confirm=1 is required) and every export is audited.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const SOURCES: EventGuestSource[] = [
  'invite',
  'public',
  'request',
  'import',
  'host',
  'walk_in',
  'plus_one',
];

export async function GET(request: NextRequest, context: Context) {
  const gate = await eventsAuth('guests-export', { max: 20 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  if (params.get('confirm') !== '1') {
    return fail({ code: 'invalid_input', message: 'Confirm the export first.' });
  }
  const { id } = await context.params;
  const tab = params.get('tab');
  const source = params.get('source');
  const filtered = ['tab', 'session', 'tag', 'source', 'q', 'referral'].some((k) => params.get(k));
  const filter: GuestFilter | null = filtered
    ? {
        tab: tab && (GUEST_TABS as readonly string[]).includes(tab) ? (tab as GuestTab) : 'all',
        sessionId: params.get('session') || null,
        tag: params.get('tag') || null,
        source:
          source && (SOURCES as string[]).includes(source) ? (source as EventGuestSource) : null,
        referral: params.get('referral') || null,
        q: (params.get('q') ?? '').slice(0, 200),
      }
    : null;
  const result = await exportGuests(getStore(), gate.owner, id, {
    filter,
    kind: params.get('kind') === 'headcount' ? 'headcount' : 'guests',
  });
  if (!result.ok) return fail(result.error);
  return new Response(result.value.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.value.filename}"`,
      'Cache-Control': 'no-store, private',
    },
  });
}
