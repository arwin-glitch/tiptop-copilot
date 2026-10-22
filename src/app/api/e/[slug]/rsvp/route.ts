import type { NextRequest } from 'next/server';
import {
  RSVP_LIMIT,
  formProblemMessage,
  formTokenProblem,
  honeypotTripped,
  publicDone,
  publicFail,
  publicGate,
  readJsonBody,
  turnstileRequired,
  verifyTurnstile,
} from '@/lib/events/public-gate';
import { publicRsvpInput } from '@/lib/events/registration';
import { RSVP_COOKIE, rememberCookieOptions } from '@/lib/events/tokens';
import { getStore } from '@/lib/runtime';
import { resolvePublicEvent } from '@/lib/services/event-public';
import { registerPublic } from '@/lib/services/event-rsvp';

/**
 * POST /api/e/<slug>/rsvp — the public RSVP form (D-075): open and approval
 * events, and an invite-only page's "Request an invite". No session.
 *
 * Brakes, in order: same-origin, 5 per 10 minutes per event per address
 * bucket, a 16 KB body, the honeypot, the signed render time (≥ 2 s), strict
 * zod, Turnstile when enabled for an open public event. Then the atomic
 * registration (event_register). An email already on the list gets the same
 * neutral message whoever asks, and never a link.
 *
 * Answers only with the outcome per session and the new guest's own ticket
 * path; the remembered-RSVP cookie is httpOnly and scoped to /e/<slug>.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { slug } = await context.params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind !== 'event') {
    return publicFail({ code: 'not_found', message: 'That event does not exist.' });
  }
  const { event, sessions } = resolved;
  const gate = publicGate(request, { limits: [RSVP_LIMIT(event.id)] });
  if (!gate.ok) return gate.response;

  const read = await readJsonBody(request);
  if (!read.ok) return publicFail(read.error);
  const raw =
    read.body && typeof read.body === 'object' ? (read.body as Record<string, unknown>) : {};
  if (honeypotTripped(raw.website)) {
    return publicFail({ code: 'invalid_input', message: formProblemMessage('invalid') });
  }
  const parsed = publicRsvpInput.safeParse(raw);
  if (!parsed.success) {
    return publicFail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
    });
  }
  const problem = formTokenProblem(parsed.data.formToken, event.id);
  if (problem) return publicFail({ code: 'invalid_input', message: formProblemMessage(problem) });
  if (
    turnstileRequired(event) &&
    !(await verifyTurnstile(parsed.data.turnstileToken, gate.visitor.ip))
  ) {
    return publicFail({ code: 'forbidden', message: 'Please complete the check and try again.' });
  }

  const result = await registerPublic(store, event, sessions, parsed.data, {
    ipHash: gate.visitor.ipHash,
  });
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
    rememberCookieOptions(event.slug, request.nextUrl.protocol === 'https:'),
  );
  return response;
}
