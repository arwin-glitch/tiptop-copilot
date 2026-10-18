import { NextResponse, type NextRequest } from 'next/server';
import {
  isSameOrigin,
  isWellFormedSecret,
  POLL_COOKIE,
  pollCookieOptions,
  readPollStatus,
} from '@/lib/auth/desktop-handoff';
import type { DataStore } from '@/lib/db/store';
import type { DesktopFlowStatus } from '@/lib/desktop/shared';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

/** The flow state, clearing the poll cookie once nothing more can happen. */
function answer(view: DesktopFlowStatus): NextResponse {
  const response = NextResponse.json({ ok: true, value: view }, { headers: NO_STORE });
  if (view.status === 'signed_in' || view.status === 'expired' || view.status === 'failed') {
    // Set with the same path and an immediate expiry: a bare delete() would
    // miss the path the cookie was set on.
    response.cookies.set(POLL_COOKIE, '', pollCookieOptions(0));
  }
  return response;
}

/**
 * Where the app's desktop sign-in stands (lib/auth/desktop-handoff.ts):
 * waiting for the browser, ready for the code, or over. Read-only; typing the
 * code goes to /api/auth/desktop/verify. The app polls this every couple of
 * seconds, so the brake is per address and generous, and checked before any
 * read; there is no global one for a single client to exhaust.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return fail(err('forbidden', 'This request must come from Copilot itself.').error);
  }
  if (!rateLimit(`desktop-handoff-poll:${addressKey(request.headers)}`, 120, 60_000).ok) {
    return fail(err('rate_limited', 'Checking too often. Slowing down.').error);
  }

  const secret = request.cookies.get(POLL_COOKIE)?.value;
  if (!isWellFormedSecret(secret)) return answer({ status: 'expired' });

  let store: DataStore;
  try {
    store = getStore();
  } catch {
    return fail(err('not_configured', 'Sign-in is not configured on this server.').error);
  }
  const view = await readPollStatus(store, secret);
  if (!view.ok) return fail(view.error);
  return answer(view.value);
}
