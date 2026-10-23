import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { VOICE_ENROLL } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { enrollVoice } from '@/lib/services/voice-profiles';

export const dynamic = 'force-dynamic';

/**
 * Remember one consented person's voice (VoiceEnrollRequest →
 * VoiceConsentResponse): the identifiers are sealed with VOICEPRINT_ENC_KEY
 * on arrival and never returned. Refused without consent on file.
 */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'voice', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, VOICE_ENROLL);
  if (!body.ok) return body.response;
  const saved = await enrollVoice({ store: getStore(), auth: gate.auth }, body.value);
  return saved.ok ? done({ profile: saved.value }) : fail(saved.error);
}
