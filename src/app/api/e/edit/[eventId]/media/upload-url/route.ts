import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { processWide } from '@/lib/util/process-state';
import { createUploadUrl } from '@/lib/services/event-media';
import { grantFail, grantGate, grantRespond, readJson } from '../../../_grant';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ eventId: string }> };

/** Outsider upload brakes (D-075): 20 an hour per link, 200 MB a day per event. */
const UPLOADS_PER_HOUR = 20;
const BYTES_PER_EVENT_PER_DAY = 200 * 1024 * 1024;

const BODY = z.strictObject({
  kind: z.enum(['image', 'video', 'logo']),
  contentType: z.string().max(100),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
  name: z.string().max(200),
});

const budgets = () =>
  processWide(
    'event-outsider-upload-bytes',
    () => new Map<string, { day: string; bytes: number }>(),
  );

/**
 * A signed upload URL for an outside editor, into THIS event's storage only
 * (WS1's media pipeline). Outsiders never upload gated files: gating is an
 * owner decision.
 */
export async function POST(request: NextRequest, context: Context) {
  const { eventId } = await context.params;
  const gate = await grantGate(request, eventId, {
    bucket: 'upload',
    max: UPLOADS_PER_HOUR,
    windowMs: 3_600_000,
  });
  if (!gate.ok) return gate.response;
  if (!gate.session.grant.capabilities.uploadMedia) {
    return grantFail({ code: 'forbidden', message: 'This link cannot add photos or videos.' });
  }
  const parsed = BODY.safeParse(await readJson(request, 4096));
  if (!parsed.success) {
    return grantFail({ code: 'invalid_input', message: 'That file could not be read.' });
  }
  const day = new Date().toISOString().slice(0, 10);
  const map = budgets();
  const used = map.get(eventId);
  const spent = used && used.day === day ? used.bytes : 0;
  if (spent + parsed.data.bytes > BYTES_PER_EVENT_PER_DAY) {
    return grantFail({
      code: 'rate_limited',
      message: 'This event has had a lot of uploads today. Try again tomorrow.',
    });
  }
  const ticket = await createUploadUrl(gate.store, gate.actor, eventId, {
    ...parsed.data,
    gated: false,
  });
  if (ticket.ok) map.set(eventId, { day, bytes: spent + parsed.data.bytes });
  return grantRespond(gate, ticket, (t) => ({ ticket: t }));
}
