import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { VOICE_CONSENT } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { listVoiceProfiles, setVoiceConsent } from '@/lib/services/voice-profiles';
import { VOICE_CONSENT_TEXT, VOICE_CONSENT_TEXT_VERSION } from '@/lib/types/notes';

export const dynamic = 'force-dynamic';

/** Voice consent on file, and the wording it is given to (ListVoiceProfilesResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 120 });
  if (!gate.ok) return gate.response;
  const listed = await listVoiceProfiles({ store: getStore(), auth: gate.auth });
  if (!listed.ok) return fail(listed.error);
  return done({
    profiles: listed.value,
    consentText: VOICE_CONSENT_TEXT,
    consentTextVersion: VOICE_CONSENT_TEXT_VERSION,
  });
}

/**
 * Grant or withdraw voice consent (VoiceConsentRequest → VoiceConsentResponse).
 * Withdrawing deletes the identifier at once.
 */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'voice', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, VOICE_CONSENT);
  if (!body.ok) return body.response;
  const saved = await setVoiceConsent({ store: getStore(), auth: gate.auth }, body.value);
  return saved.ok ? done({ profile: saved.value }) : fail(saved.error);
}
