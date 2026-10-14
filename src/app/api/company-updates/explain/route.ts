import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { explainUpdate } from '@/lib/services/company-updates';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/** Signed-in only: why one Gmail message is or isn't in Fresh company updates. */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f]{10,24}$/i.test(id)) return fail({ code: 'invalid_input', message: 'Bad id.' });
  const result = await explainUpdate(getStore(), s.auth.organizationId, id);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
