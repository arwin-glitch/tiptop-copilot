import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { setAlertsPreference } from '@/lib/services/ios-push';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

/**
 * Where your alerts go when you have both the iPhone app and the home-screen
 * web app: "Send alerts here instead" in the web app (`web`), and the way
 * back in the app (`app`). Your own choice only (lib/services/ios-push.ts).
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`push-preference:${auth.value.userId}`, 20, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = z
    .object({ to: z.enum(['app', 'web']) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(err('invalid_input', 'Say app or web.').error);
  await setAlertsPreference(getStore(), auth.value, parsed.data.to);
  return NextResponse.json({ ok: true, to: parsed.data.to }, { headers: NO_STORE });
}
