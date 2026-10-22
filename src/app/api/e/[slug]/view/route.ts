import type { NextRequest } from 'next/server';
import { publicDone, publicFail, publicGate, readJsonBody } from '@/lib/events/public-gate';
import {
  GUEST_TOKEN_RE,
  RSVP_COOKIE,
  rememberCookieOptions,
  rememberCookieValue,
} from '@/lib/events/tokens';
import { getStore } from '@/lib/runtime';
import { recordPageView, resolveInvite, resolvePublicEvent } from '@/lib/services/event-public';

/**
 * POST /api/e/<slug>/view — the page-view beacon (D-075). A GET never
 * records anything; this JS POST does, once per visitor per day (a daily
 * salted hash of address and browser, never the address). On a personal
 * link it also marks the guest's "viewed" in the host's funnel and lets this
 * browser remember the guest (httpOnly cookie scoped to /e/<slug>).
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { slug } = await context.params;
  const gate = publicGate(request, { limits: [{ bucket: 'ev-view', max: 60, windowMs: 60_000 }] });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug, { personal: true });
  if (resolved.kind !== 'event') return publicFail({ code: 'not_found', message: 'Not found.' });
  const read = await readJsonBody(request, 2048);
  const body =
    read.ok && read.body && typeof read.body === 'object'
      ? (read.body as Record<string, unknown>)
      : {};
  const token =
    typeof body.token === 'string' && GUEST_TOKEN_RE.test(body.token) ? body.token : null;
  const source =
    typeof body.source === 'string' ? body.source.replace(/[^\w.\-: ]/g, '').slice(0, 120) : null;
  const guest = token ? await resolveInvite(store, resolved.event, token) : null;
  // A private event opens only through a guest's own link.
  if (resolved.event.visibility === 'private' && !guest) {
    return publicFail({ code: 'not_found', message: 'Not found.' });
  }
  await recordPageView(store, resolved.event, {
    ip: gate.visitor.ip,
    userAgent: request.headers.get('user-agent') ?? '',
    guestId: guest?.guest.id ?? null,
    source: source || null,
  });
  const response = publicDone();
  if (guest) {
    response.cookies.set(
      RSVP_COOKIE,
      rememberCookieValue({
        eventId: resolved.event.id,
        guestId: guest.guest.id,
        tokenVersion: guest.guest.token_version,
      }),
      rememberCookieOptions(resolved.event.slug, request.nextUrl.protocol === 'https:'),
    );
  }
  return response;
}
