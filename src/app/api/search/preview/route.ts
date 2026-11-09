import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { parsePreviewRequest, previewCard } from '@/lib/services/search-preview';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The quick search's hover preview for any result: signed-in only, scoped to
 * the caller's organization.
 *
 * `?kind=crm|mail|portfolio|deal|network|harmonic_person|harmonic_company&key=<v>`
 * (uuid / email / digits, checked strictly), or the older `?id=<recordId>`
 * for a CRM record. Answers `{ ok, card, preview? }` — `preview` is the older
 * CRM shape, sent for kind crm only. Reads the database and the cached
 * relationship index; the Harmonic kinds make one quota-guarded call, kept a
 * day.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code), headers: NO_STORE },
    );
  }
  const parsed = parsePreviewRequest(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400, headers: NO_STORE },
    );
  }
  const result = await previewCard(getStore(), auth.value, parsed.value);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: statusForError(result.error.code), headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, ...result.value }, { headers: NO_STORE });
}
