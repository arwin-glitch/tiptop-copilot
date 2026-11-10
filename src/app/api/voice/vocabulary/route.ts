import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';
import { voiceTerms } from '@/lib/voice/vocabulary';

export const dynamic = 'force-dynamic';

const MAX_TERMS = 2_000;

/**
 * The names Voice Arwin spells speech toward (src/lib/voice/fix.ts):
 * portfolio companies, open deals and the team's network contacts. Signed in
 * only, the caller's organization only; names, nothing else. The browser asks
 * once per page load and keeps it in memory.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`voice-vocab:${auth.value.userId}`, 20, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }
  const terms = await voiceTerms(getStore(), auth.value.organizationId);
  return NextResponse.json(
    { ok: true, terms: terms.slice(0, MAX_TERMS) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
