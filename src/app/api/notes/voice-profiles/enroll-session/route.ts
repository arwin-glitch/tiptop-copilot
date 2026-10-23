import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { VOICE_ENROLL_SESSION } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { enrollmentSession } from '@/lib/services/voice-profiles';
import { NOTES_LIMITS } from '@/lib/types/notes';

export const dynamic = 'force-dynamic';

/**
 * The consent check and speech settings for one consented person's solo clip
 * (VoiceEnrollSessionRequest → VoiceEnrollSessionResponse), asked before the
 * clip is captured. Refused without consent on file. Counts against the same
 * hourly limit as meeting speech setups.
 */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, {
    bucket: 'speech',
    max: NOTES_LIMITS.speechSetupsPerHour,
    windowMs: 60 * 60_000,
    write: true,
  });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, VOICE_ENROLL_SESSION);
  if (!body.ok) return body.response;
  const setup = await enrollmentSession({ store: getStore(), auth: gate.auth }, body.value.email);
  return setup.ok ? done({ ...setup.value }) : fail(setup.error);
}
