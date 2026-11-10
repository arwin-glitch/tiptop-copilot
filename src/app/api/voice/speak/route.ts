import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Spoken answers are short (lib/voice/intent.ts spokenText caps them near 320). */
const MAX_CHARS = 600;
/** Flash: ElevenLabs' fastest, cheapest model, made for live replies. */
const MODEL = 'eleven_flash_v2_5';

function configured(): { key: string; voice: string } | null {
  const e = env();
  return e.elevenLabsApiKey && e.elevenLabsVoiceId
    ? { key: e.elevenLabsApiKey, voice: e.elevenLabsVoiceId }
    : null;
}

/** Whether Voice Arwin has a cloned voice; the browser's own voice otherwise. */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  return NextResponse.json(
    { ok: true, available: configured() !== null },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * One spoken answer in the cloned voice, as MP3. Signed in only; the key
 * never leaves the server. Any failure answers an error and the browser
 * falls back to its own voice.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`voice-speak:${auth.value.userId}`, 40, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }
  const voice = configured();
  if (!voice) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_configured', message: 'No cloned voice is set up.' } },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_CHARS) : '';
  if (!text) {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Nothing to say.' } },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': voice.key,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: MODEL }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    log.warn('Voice Arwin: ElevenLabs could not be reached', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { ok: false, error: { code: 'upstream', message: 'The voice service did not answer.' } },
      { status: 502 },
    );
  }
  if (!upstream.ok || !upstream.body) {
    log.warn('Voice Arwin: ElevenLabs refused the request', { status: upstream.status });
    return NextResponse.json(
      { ok: false, error: { code: 'upstream', message: 'The voice service refused.' } },
      { status: 502 },
    );
  }
  return new NextResponse(upstream.body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' },
  });
}
