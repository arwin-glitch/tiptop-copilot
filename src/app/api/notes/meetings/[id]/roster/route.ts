import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { APPLY_ROSTER } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { applyRoster } from '@/lib/services/notes-settings';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * The meeting app's speaking timeline (the Meet extension's roster), lined up
 * with the meeting-audio voices (ApplyRosterRequest → ApplyRosterResponse).
 * Recorder only. Names nobody picked by hand; the timeline is not stored.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, APPLY_ROSTER);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const applied = await applyRoster({ store: getStore(), auth: gate.auth }, id, body.value.turns);
  return applied.ok ? done({ ...applied.value }) : fail(applied.error);
}
