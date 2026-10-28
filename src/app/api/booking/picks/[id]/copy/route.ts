import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { copyPickAgain } from '@/lib/services/booking-picks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copy again (Pick times): the same link and clipboard text as when the
 * pick was made, while it is open. Signed in, a member or above, from
 * Kraken's own pages. Answers `{ url, text, html, expiresAt }`.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking-pick-copy', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return fail({ code: 'not_found', message: 'Those picked times are not here any more.' });
  }
  const result = await copyPickAgain(
    { store: getStore(), organizationId: gate.auth.organizationId, userId: gate.auth.userId },
    id,
  );
  if (!result.ok) return fail(result.error);
  return done({ ...result.value });
}
