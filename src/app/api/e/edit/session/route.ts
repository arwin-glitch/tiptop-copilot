import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import {
  appendGrantCookies,
  claimGrant,
  clearedGrantCookies,
  grantCookies,
  previewGrant,
} from '@/lib/events/editor-auth';
import { eventPaths } from '@/lib/events/contracts';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { clientAddress } from '@/lib/security/client-address';
import { grantFail, notValid, readJson } from '../_grant';

export const dynamic = 'force-dynamic';

const BODY = z.strictObject({
  token: z.string().max(64),
  /** false: only say who the link is for (no side effects); true: the explicit claim. */
  claim: z.boolean(),
});

/**
 * The outside editor's entry (/e/edit). The page reads the secret from the
 * URL fragment and POSTs it here, never in a URL:
 *   { claim: false } → who the link is for and what it allows (no writes);
 *   { claim: true }  → the explicit click: set the path-scoped session
 *                      cookie and answer where the editor lives.
 * Unknown, expired and revoked links all get the same 404.
 */
export async function POST(request: NextRequest) {
  // Same-origin only, like the staff claim: a cross-site form must not plant
  // an edit link's cookie in someone's browser, or test secrets from elsewhere.
  if (!isSameOrigin(request)) return notValid();
  const parsed = BODY.safeParse(await readJson(request, 4096));
  if (!parsed.success) return notValid();
  const store = getStore();
  const ip = clientAddress(request.headers);

  if (!parsed.data.claim) {
    const preview = await previewGrant(store, { token: parsed.data.token, ip });
    if (!preview.ok) {
      return preview.error.code === 'rate_limited' ? grantFail(preview.error) : notValid();
    }
    return NextResponse.json(
      { ok: true, preview: preview.value },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const claimed = await claimGrant(store, {
    token: parsed.data.token,
    ip,
    userAgent: request.headers.get('user-agent'),
  });
  if (!claimed.ok) {
    return claimed.error.code === 'rate_limited' ? grantFail(claimed.error) : notValid();
  }
  const { grant, cookieValue, maxAgeSeconds } = claimed.value;
  const response = NextResponse.json(
    { ok: true, location: eventPaths.editStudio(grant.eventId) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  appendGrantCookies(
    response.headers,
    grantCookies(grant.role, grant.eventId, cookieValue, maxAgeSeconds),
  );
  return response;
}

/** Leave: clear this event's session cookie on every path it was set on. */
export async function DELETE(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get('event') ?? '';
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  if (!ID_RE.test(eventId)) return response;
  appendGrantCookies(response.headers, clearedGrantCookies('editor', eventId));
  return response;
}
