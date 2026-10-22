import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { postDemoRelay, setDemoBridge } from '@/lib/notes/relay';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';

export const dynamic = 'force-dynamic';

const BODY = z
  .object({
    /** A message as if Arwin's routine had posted it (NOTES_RESULT_V1 or ASK_ANSWER_V1). */
    text: z.string().min(1).max(40_000).optional(),
    /** Route the meeting chat through the bridge in this demo server (true) or quote at once (false). */
    bridge: z.boolean().optional(),
  })
  .strict();

/**
 * Demo mode only (D-076): plays Arwin's routine for the end-to-end tests and
 * for a look at the flow without Slack. There is no relay channel in demo
 * mode, so this stands in for one. Outside demo mode it does not exist.
 */
export async function POST(request: NextRequest) {
  if (!env().demoMode) return fail({ code: 'not_found', message: 'Not found.' });
  const gate = await notesGate(request, { bucket: 'demo-relay', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, BODY);
  if (!body.ok) return body.response;
  if (body.value.bridge !== undefined) setDemoBridge(body.value.bridge);
  if (body.value.text) postDemoRelay(body.value.text);
  return done({ posted: Boolean(body.value.text), bridge: body.value.bridge ?? null });
}
