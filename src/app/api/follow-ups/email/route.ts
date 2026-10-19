import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { readFollowUpEmail } from '@/lib/services/follow-up-email';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/**
 * The full email behind a follow-up, as plain text. Reading never changes
 * anything in Gmail. `fresh=1` asks Gmail again rather than the minute-old
 * copy, for the email session, where a reply goes to the newest message.
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const params = request.nextUrl.searchParams;
  const email = await readFollowUpEmail(getStore(), s.auth.organizationId, params.get('id') ?? '', {
    integration: s.integration,
    fresh: params.get('fresh') === '1',
  });
  if (!email.ok) return fail(email.error);
  return NextResponse.json(
    { ok: true, email: email.value },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
