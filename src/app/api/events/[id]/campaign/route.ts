import type { NextRequest } from 'next/server';
import { env } from '@/lib/config/env';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { draftEventMessage } from '@/lib/services/event-comms';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** A message request is a kind and an audience; a list of up to 2,000 guest ids at most. */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Draft an event message (signed-in members):
 * { kind: invite|reminder|notice|update|cancellation|blast|nudge, audience?,
 *   sessionId?, offsetMinutes?, notifyKind?, segment?, sender? }
 *   → { campaignId, name, added, left, notLive }.
 *
 * It makes a campaign DRAFT and sends nothing: the page then opens the draft
 * in the campaign review, where a person reads it and taps Send, under the
 * campaign rules (daily cap, recipient limit, send lease). See
 * lib/services/event-comms.ts.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('campaign', { max: 30 });
  if (!gate.ok) return gate.response;
  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) {
    return fail({ code: 'too_large', message: 'That message request is too large.' });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail({ code: 'invalid_input', message: 'That message could not be read.' });
  }
  const { id } = await context.params;
  const result = await draftEventMessage(getStore(), gate.owner, id, body, {
    appUrl: env().appUrl,
  });
  return respond(result, (r) => ({ ...r }));
}
