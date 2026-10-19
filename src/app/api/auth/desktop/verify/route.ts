import { NextResponse, type NextRequest } from 'next/server';
import {
  demoHandoffs,
  finishHandoff,
  isSameOrigin,
  isWellFormedSecret,
  POLL_COOKIE,
  pollCookieOptions,
  verifyHandoffCode,
} from '@/lib/auth/desktop-handoff';
import { isEmailAllowed } from '@/lib/auth/domain';
import { startDemoSession, supabaseServerClient } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS } from '@/lib/demo/ids';
import { isIosAppRequest } from '@/lib/ios/server';
import { MATCH_CODE_RE, normalizeMatchCode, type DesktopVerifyStatus } from '@/lib/desktop/shared';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { addressKey, clientAddress } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { DesktopHandoff } from '@/lib/types/domain';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

/** The outcome, clearing the poll cookie once nothing more can happen. */
function answer(view: DesktopVerifyStatus): NextResponse {
  const response = NextResponse.json({ ok: true, value: view }, { headers: NO_STORE });
  if (view.status === 'signed_in' || view.status === 'expired' || view.status === 'failed') {
    response.cookies.set(POLL_COOKIE, '', pollCookieOptions(0));
  }
  return response;
}

async function auditSignIn(
  store: DataStore,
  userId: string,
  row: DesktopHandoff,
  request: NextRequest,
): Promise<void> {
  const membership = (await store.membershipsForUser(userId))[0];
  if (!membership) return;
  await recordAudit(store, {
    organizationId: membership.organization_id,
    userId,
    action: 'auth.desktop_signed_in',
    entityType: 'session',
    entityId: null,
    // The stored platform is mac, windows or other; the iPhone app says so
    // in its own user agent (a hint, recorded and never relied on).
    metadata: { platform: isIosAppRequest(request) ? 'ios' : row.platform },
    ip: clientAddress(request.headers),
  });
}

/**
 * The person typed the code their browser showed into the desktop app
 * (lib/auth/desktop-handoff.ts). A right code claims the hand-off for this
 * request alone, which then exchanges Google's code with the verifier in the
 * app's cookies: exactly once, because Supabase deletes the verifier even
 * when an exchange fails. The session cookies ride on this response, so the
 * app only has to load /today. It never redirects: a relative navigation in
 * the app keeps the cookies on the app's own host.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return fail(err('forbidden', 'This request must come from Copilot itself.').error);
  }
  if (!rateLimit(`desktop-handoff-verify:${addressKey(request.headers)}`, 20, 60_000).ok) {
    return fail(err('rate_limited', 'Too many tries. Wait a minute, then try again.').error);
  }

  const secret = request.cookies.get(POLL_COOKIE)?.value;
  if (!isWellFormedSecret(secret)) return answer({ status: 'expired' });

  let code = '';
  try {
    const body = (await request.json()) as { code?: unknown } | null;
    if (typeof body?.code === 'string' && body.code.length <= 32) {
      code = normalizeMatchCode(body.code);
    }
  } catch {
    // An unreadable body is a malformed code, answered below.
  }
  if (!MATCH_CODE_RE.test(code)) {
    return fail(err('invalid_input', 'Type the 4 characters your browser shows.').error);
  }

  const notConfigured = () =>
    fail(err('not_configured', 'Sign-in is not configured on this server.').error);
  let demo: boolean;
  let store: DataStore;
  try {
    demo = demoHandoffs();
    store = getStore();
  } catch {
    return notConfigured();
  }
  const supabase = demo ? null : await supabaseServerClient();
  if (!demo && !supabase) return notConfigured();

  const outcome = await verifyHandoffCode(store, { pollSecret: secret, code });
  if (!outcome.ok) return fail(outcome.error);
  if (outcome.value.kind === 'status') return answer(outcome.value.status);

  // This request holds the claim; everything below runs once per hand-off.
  const { row, authCode } = outcome.value;

  if (demo || !supabase) {
    await startDemoSession();
    await finishHandoff(store, row.id, 'signed_in');
    await auditSignIn(store, DEMO_IDS.user, row, request);
    return answer({ status: 'signed_in' });
  }

  if (!authCode) {
    await finishHandoff(store, row.id, 'exchange');
    return answer({ status: 'failed', reason: 'exchange' });
  }

  let user: { id: string; email?: string | null } | null = null;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(
      authCode,
      row.flow_id ? { flowId: row.flow_id } : undefined,
    );
    if (!error && data?.user) user = data.user;
  } catch (error) {
    log.warn('Desktop sign-in exchange threw', {
      handoff: row.id.slice(0, 8),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!user) {
    await finishHandoff(store, row.id, 'exchange');
    return answer({ status: 'failed', reason: 'exchange' });
  }

  // The same gate as /api/auth/callback: a database trigger gives every new
  // user a workspace, so an account outside the allow-list is signed straight
  // back out rather than left with a session.
  if (!isEmailAllowed(user.email)) {
    await supabase.auth.signOut();
    await finishHandoff(store, row.id, 'domain');
    return answer({ status: 'failed', reason: 'domain' });
  }

  await finishHandoff(store, row.id, 'signed_in');
  await auditSignIn(store, user.id, row, request);
  return answer({ status: 'signed_in' });
}
