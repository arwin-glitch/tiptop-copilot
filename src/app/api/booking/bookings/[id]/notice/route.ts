import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/session';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { releaseNoticeFor } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The notice for a held time that was released because it was taken
 * (D-078): `{ draft: { to, subject, body } }` for the compose window, which
 * sends only on a person's Send. Copilot sends nothing itself.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking-notice', max: 30 });
  if (!gate.ok) return gate.response;
  const member = requireRole(gate.auth, 'member');
  if (!member.ok) return fail(member.error);
  const { id } = await context.params;
  if (!UUID.test(id))
    return fail({ code: 'not_found', message: 'There is no notice for this booking.' });
  const draft = await releaseNoticeFor(getStore(), gate.auth.organizationId, id);
  if (!draft.ok) return fail(draft.error);
  return done({ draft: draft.value });
}
