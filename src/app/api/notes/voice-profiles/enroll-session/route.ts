import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { VOICE_ENROLL_SESSION } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { enrollmentSession } from '@/lib/services/voice-profiles';
import { NOTES_LIMITS } from '@/lib/types/notes';

export const dynamic = 'force-dynamic';

/**
 * A speech session for one consented person's solo clip
 * (VoiceEnrollSessionRequest → VoiceEnrollSessionResponse). Refused without
 * consent on file. Counts against the same hourly limit as meeting sessions.
 */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, {
    bucket: 'stt',
    max: NOTES_LIMITS.sttTokensPerHour,
    windowMs: 60 * 60_000,
    write: true,
  });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, VOICE_ENROLL_SESSION);
  if (!body.ok) return body.response;
  const minted = await enrollmentSession({ store: getStore(), auth: gate.auth }, body.value.email);
  return minted.ok ? done({ ...minted.value }) : fail(minted.error);
}
