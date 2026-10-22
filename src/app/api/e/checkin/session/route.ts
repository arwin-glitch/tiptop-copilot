import type { NextRequest } from 'next/server';
import { eventPaths } from '@/lib/events/contracts';
import { appendGrantCookies, claimGrant, grantCookies } from '@/lib/events/editor-auth';
import { publicDone, publicFail, publicGate, readJsonBody } from '@/lib/events/public-gate';
import { getStore } from '@/lib/runtime';

/**
 * POST /api/e/checkin/session — claim a staff check-in link (D-075). The
 * secret travels in the link's #k= fragment (never sent to a server on a
 * GET); the entry page strips it and POSTs it here on an explicit tap, so
 * link scanners and prefetch can never claim it. WS3's claimGrant checks it
 * (rate limited, hashed, expiry, revocation, and only the 'checkin' role)
 * and returns the signed cookie value, set httpOnly and SameSite=Strict
 * only on this event's door list and its API, plus the event's QR landing
 * paths (one Set-Cookie header per path). Anything else is the same generic
 * 404.
 */

export const dynamic = 'force-dynamic';

const NOT_FOUND = { code: 'not_found' as const, message: 'This link is not valid.' };

export async function POST(request: NextRequest) {
  const gate = publicGate(request, {
    limits: [{ bucket: 'ev-staff-claim', max: 10, windowMs: 10 * 60_000 }],
  });
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(request, 1024);
  if (!read.ok) return publicFail(read.error);
  const token =
    read.body && typeof read.body === 'object'
      ? (read.body as Record<string, unknown>).token
      : null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token))
    return publicFail(NOT_FOUND);
  const store = getStore();
  const claimed = await claimGrant(store, {
    token,
    ip: gate.visitor.ip,
    userAgent: request.headers.get('user-agent'),
    roles: ['checkin'],
  });
  if (!claimed.ok || claimed.value.grant.role !== 'checkin') return publicFail(NOT_FOUND);
  const { grant } = claimed.value;
  const event = await store.get('events', grant.organizationId, grant.eventId).catch(() => null);
  const response = publicDone({
    eventId: grant.eventId,
    path: eventPaths.doorList(grant.eventId),
  });
  appendGrantCookies(
    response.headers,
    grantCookies(
      'checkin',
      grant.eventId,
      claimed.value.cookieValue,
      claimed.value.maxAgeSeconds,
      event?.slug ?? null,
    ),
  );
  return response;
}
