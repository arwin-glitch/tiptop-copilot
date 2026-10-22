import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { SPEECH_SETUP } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { speechSessions } from '@/lib/services/notes';
import { knownVoicesFor } from '@/lib/services/voice-profiles';
import { NOTES_LIMITS } from '@/lib/types/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * The recorder's speech settings (SpeechSetupRequest → SpeechSetupResponse):
 * per track, the language, the names to spell right and the consented voices
 * to recognise. No key, no vendor, nothing paid for: the browser runs Whisper
 * itself. Recorder only, while recording; 60 an hour per person.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, {
    bucket: 'speech',
    max: NOTES_LIMITS.speechSetupsPerHour,
    windowMs: 60 * 60_000,
    write: true,
  });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, SPEECH_SETUP);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  // Consented, enrolled voices on the invite (and the team) are recognised in
  // the recorder's speech worker, labelled by profile id; nobody else is ever
  // in the list.
  const setup = await speechSessions(ctx, id, body.value.tracks, {
    knownVoices: (emails) => knownVoicesFor(ctx, emails),
  });
  return setup.ok ? done({ ...setup.value }) : fail(setup.error);
}
