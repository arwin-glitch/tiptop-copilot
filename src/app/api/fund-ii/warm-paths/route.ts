import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { affinityPeopleAt } from '@/lib/services/network-helpers';
import { findWarmPaths, parseWarmPathsQuery } from '@/lib/services/warm-paths';

export const dynamic = 'force-dynamic';

/**
 * Who can introduce Nick to a prospective LP: `?email=`, `?thread=` (with an
 * optional `firm` hint) or `?firm=`. Reads Gmail headers only; never writes.
 * The people Affinity holds at the same firm (or address) are added, with the
 * lists they are on: names and lists only, never an amount.
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`warm-paths:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const query = parseWarmPathsQuery(request.nextUrl.searchParams);
  if (!query.ok) return fail(query.error);
  const result = await findWarmPaths(getStore(), s.auth.organizationId, s.integration, query.value);
  if (!result.ok) return fail(result.error);
  const target = result.value.target;
  const affinity = target ? await affinityPeopleAt(getStore(), s.auth.organizationId, target) : [];
  return NextResponse.json(
    { ok: true, result: { ...result.value, affinity } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
