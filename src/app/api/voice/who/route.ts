import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { whoIsMeant } from '@/lib/services/who-is-meant';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * Who Voice Arwin means by a spoken name ("reply to Patrick", "coffee with
 * Sarah"): the one clear match among people Nick has emailed or met, and
 * their latest email thread. `ambiguous` with the candidates when two fit
 * about equally, so Voice Arwin asks rather than guesses. Read-only; names,
 * addresses and a subject, nothing else. Signed in only.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`voice-who:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }
  const name = (request.nextUrl.searchParams.get('name') ?? '').trim().slice(0, 80);
  if (name.length < 2) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_input' } }, { status: 400 });
  }
  const who = await whoIsMeant(getStore(), auth.value, name);
  return NextResponse.json(
    { ok: true, ...who },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
