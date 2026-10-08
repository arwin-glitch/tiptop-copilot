import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { ANSWER_SCHEMA, recordAnswer } from '@/lib/services/email-session';
import { fail, personName, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/** Record one decision in the email session (pass, later, a note for Arwin, ...). */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const parsed = ANSWER_SCHEMA.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Bad answer.' });
  await recordAnswer(
    getStore(),
    s.auth.organizationId,
    { id: s.auth.userId, name: personName(s.auth) },
    parsed.data,
  );
  return NextResponse.json({ ok: true });
}
