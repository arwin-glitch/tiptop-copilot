import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { STT_TOKEN } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { mintSttSessions } from '@/lib/services/notes';
import { knownSpeakersFor } from '@/lib/services/voice-profiles';
import { NOTES_LIMITS } from '@/lib/types/notes';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Speech sessions for the recorder (SttTokenRequest → SttTokenResponse): a
 * 60-second vendor key per track, minted from the key that stays on the
 * server. Recorder only, while recording; 30 an hour per person.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, {
    bucket: 'stt',
    max: NOTES_LIMITS.sttTokensPerHour,
    windowMs: 60 * 60_000,
    write: true,
  });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, STT_TOKEN);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const ctx = { store: getStore(), auth: gate.auth };
  // Consented, enrolled voices on the invite (and the team) are recognised
  // by the vendor, labelled by profile id; nobody else is ever in the list.
  const minted = await mintSttSessions(ctx, id, body.value.tracks, {
    knownSpeakers: (emails) => knownSpeakersFor(ctx, emails),
  });
  return minted.ok ? done({ ...minted.value }) : fail(minted.error);
}
