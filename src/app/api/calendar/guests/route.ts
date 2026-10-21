import type { NextRequest } from 'next/server';
import { isEmailAddress } from '@/lib/calendar/edit-rules';
import { calendarAuth, done } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import type { NetworkContact } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

/**
 * Guest suggestions for the event editor: people in the network whose name,
 * company or address matches what is being typed. One small substring query,
 * capped, the same kind the Ctrl+K search runs.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'guests', max: 240 });
  if (!gate.ok) return gate.response;
  const query = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 80);
  if (query.length < 2) return done({ people: [] });
  let rows: NetworkContact[] = [];
  try {
    rows = (await getStore().list(
      'network_contacts',
      gate.auth.organizationId,
      { textSearch: { columns: ['full_name', 'email', 'company'], query } },
      { limit: 8 },
    )) as NetworkContact[];
  } catch {
    rows = [];
  }
  const people = rows
    .filter((r) => r.email && isEmailAddress(r.email.toLowerCase()))
    .map((r) => ({ name: r.full_name, email: r.email!.toLowerCase(), company: r.company }))
    .slice(0, 6);
  return done({ people });
}
