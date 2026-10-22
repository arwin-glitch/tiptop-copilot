import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { LOG_CONSENT } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { logConsentEvent } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Log a consent-step event (LogConsentRequest): the notice was copied. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, LOG_CONSENT);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const logged = await logConsentEvent(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.event,
  );
  return logged.ok ? done() : fail(logged.error);
}
