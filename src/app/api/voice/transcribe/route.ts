import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';
import { keyterms, voiceTerms } from '@/lib/voice/vocabulary';

export const dynamic = 'force-dynamic';

/** A spoken command is seconds long; anything bigger is not one. */
const MAX_BYTES = 4 * 1024 * 1024;
/** ElevenLabs' most accurate speech-to-text. */
const MODEL = 'scribe_v2';
/** Key terms per organization, reused for ten minutes. */
const TERMS_TTL_MS = 10 * 60_000;
const termsCache = new Map<string, { at: number; terms: string[] }>();

function apiKey(): string | null {
  return env().elevenLabsApiKey ?? null;
}

async function termsFor(org: string): Promise<string[]> {
  const hit = termsCache.get(org);
  if (hit && Date.now() - hit.at < TERMS_TTL_MS) return hit.terms;
  const terms = keyterms(await voiceTerms(getStore(), org));
  termsCache.set(org, { at: Date.now(), terms });
  return terms;
}

/** A file name whose extension matches the recording, so the format is read right. */
function fileName(type: string): string {
  if (type.includes('mpeg') || type.includes('mp3')) return 'command.mp3';
  if (type.includes('mp4') || type.includes('m4a')) return 'command.m4a';
  if (type.includes('ogg')) return 'command.ogg';
  if (type.includes('wav')) return 'command.wav';
  return 'command.webm';
}

/** ElevenLabs' own words for a refusal (never the key), cut short. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    detail?: { message?: unknown; status?: unknown } | unknown;
  } | null;
  const detail = body?.detail as { message?: unknown; status?: unknown } | string | undefined;
  const text =
    typeof detail === 'string'
      ? detail
      : typeof detail?.message === 'string'
        ? detail.message
        : typeof detail?.status === 'string'
          ? detail.status
          : JSON.stringify(body?.detail ?? '').slice(0, 200);
  return text.slice(0, 200);
}

function failed(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/** Whether Voice Arwin can hear through ElevenLabs here. */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return failed(auth.error.code, auth.error.message, statusForError(auth.error.code));
  return NextResponse.json(
    { ok: true, available: apiKey() !== null },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * One spoken command, written down by ElevenLabs Scribe and steered toward
 * the team's own words (Kraken's pages, portfolio, deals, contacts), the way
 * a meeting notetaker spells names right. Signed in only; the audio is not
 * kept. Any failure answers an error and the browser keeps what it heard.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return failed(auth.error.code, auth.error.message, statusForError(auth.error.code));
  const limited = rateLimit(`voice-transcribe:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) {
    return failed(limited.error.code, limited.error.message, statusForError(limited.error.code));
  }
  const key = apiKey();
  if (!key) return failed('not_configured', 'No speech service is set up.', 503);

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return failed('invalid_input', 'That recording is too long.', 413);
  const audio = await request.blob().catch(() => null);
  if (!audio || audio.size < 1_000 || audio.size > MAX_BYTES) {
    return failed('invalid_input', 'No usable recording.', 400);
  }

  const terms = await termsFor(auth.value.organizationId).catch(() => []);
  const send = (withTerms: boolean) => {
    const form = new FormData();
    form.append('model_id', MODEL);
    form.append('language_code', 'en');
    form.append('tag_audio_events', 'false');
    form.append('file', audio, fileName(audio.type));
    if (withTerms) for (const term of terms) form.append('keyterms', term);
    return fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: AbortSignal.timeout(12_000),
    });
  };

  let upstream: Response;
  try {
    upstream = await send(terms.length > 0);
    // Key terms refused (plan, a term it dislikes): plain transcription still helps.
    if (!upstream.ok && upstream.status !== 401 && terms.length > 0) upstream = await send(false);
  } catch (error) {
    log.warn('Voice Arwin: speech-to-text could not be reached', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return failed('upstream', 'The speech service did not answer.', 502);
  }
  if (!upstream.ok) {
    const reason = await refusal(upstream);
    log.warn('Voice Arwin: speech-to-text refused the request', {
      status: upstream.status,
      reason,
    });
    return failed('upstream', `The speech service refused (${upstream.status}): ${reason}`, 502);
  }
  const body = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  return NextResponse.json(
    { ok: true, text },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
