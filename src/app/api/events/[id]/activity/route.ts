import type { NextRequest } from 'next/server';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { listActivity } from '@/lib/services/event-versions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * The Activity panel: who changed which keys, when. ?section=<id> for one
 * section, ?section=page for theme and page settings, none for everything.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = await eventsAuth('activity', { max: 120, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const section = request.nextUrl.searchParams.get('section');
  if (section !== null && section !== 'page' && !ID_RE.test(section)) {
    return fail({ code: 'invalid_input', message: 'That section could not be read.' });
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50');
  const result = await listActivity(getStore(), ownerActor(gate.owner), id, {
    sectionId: section === null ? undefined : section === 'page' ? null : section,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return respond(result, (activity) => ({ activity }));
}
