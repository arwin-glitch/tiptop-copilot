import type { NextRequest } from 'next/server';
import {
  formProblemMessage,
  honeypotTripped,
  publicDone,
  publicFail,
  publicGate,
  readJsonBody,
} from '@/lib/events/public-gate';
import { inviteResponseInput } from '@/lib/events/registration';
import { GUEST_TOKEN_RE, RSVP_COOKIE, rememberCookieOptions } from '@/lib/events/tokens';
import { getStore } from '@/lib/runtime';
import { resolveInvite, resolvePublicEvent } from '@/lib/services/event-public';
import { respondInvite } from '@/lib/services/event-rsvp';

/**
 * POST /api/e/<slug>/i/<token>/respond — a personal link's answers (D-075):
 * Going / Maybe / Can't go per session, plus-ones, questions. The token is
 * the only credential (a stateless HMAC naming one guest; rotation kills it).
 * Same-origin, rate-limited per address bucket, 16 KB, strict zod; applied
 * atomically through event_register(). The same link edits or cancels until
 * RSVPs close. No minimum fill time here (unlike the public form): the form
 * is prefilled and the token is the credential, so a two-tap answer is real.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

const NOT_FOUND = { code: 'not_found' as const, message: 'This invitation link is not valid.' };

export async function POST(request: NextRequest, context: Context) {
  const { slug, token } = await context.params;
  if (!GUEST_TOKEN_RE.test(token)) return publicFail(NOT_FOUND);
  const gate = publicGate(request, {
    limits: [
      { bucket: 'ev-respond', max: 20, windowMs: 10 * 60_000 },
      { bucket: `ev-respond-token:${token.slice(-12)}`, max: 30, windowMs: 10 * 60_000 },
    ],
  });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind !== 'event') return publicFail(NOT_FOUND);
  const guest = await resolveInvite(store, resolved.event, token);
  if (!guest) return publicFail(NOT_FOUND);

  const read = await readJsonBody(request);
  if (!read.ok) return publicFail(read.error);
  const raw =
    read.body && typeof read.body === 'object' ? (read.body as Record<string, unknown>) : {};
  if (honeypotTripped(raw.website)) {
    return publicFail({ code: 'invalid_input', message: formProblemMessage('invalid') });
  }
  const parsed = inviteResponseInput.safeParse(raw);
  if (!parsed.success) {
    return publicFail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check your answers and try again.',
    });
  }
  const result = await respondInvite(store, resolved.event, resolved.sessions, guest, parsed.data);
  if (!result.ok) return publicFail(result.error);
  const response = publicDone({
    outcome: {
      sessions: result.value.outcome.sessions,
      plusOnes: result.value.outcome.plusOnes.length,
    },
    ticketPath: result.value.ticketPath,
  });
  response.cookies.set(
    RSVP_COOKIE,
    result.value.rememberCookie,
    rememberCookieOptions(resolved.event.slug, request.nextUrl.protocol === 'https:'),
  );
  return response;
}
