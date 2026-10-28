import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { revokePick } from '@/lib/services/booking-picks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cancel a pick (Pick times): its link closes and its times are no longer
 * held. Signed in, a member or above, from Kraken's own pages; audited.
 * Answers `{ pick }`.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking-pick-revoke', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return fail({ code: 'not_found', message: 'Those picked times are not here any more.' });
  }
  const result = await revokePick(
    { store: getStore(), organizationId: gate.auth.organizationId, userId: gate.auth.userId },
    id,
  );
  if (!result.ok) return fail(result.error);
  return done({ ...result.value });
}
