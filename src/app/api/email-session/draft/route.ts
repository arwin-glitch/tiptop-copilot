import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { canSend, readLiveDraft, readPrimarySignature } from '@/lib/google/gmail-send';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { htmlToPlainText } from '@/lib/util/text';

export const dynamic = 'force-dynamic';

/** The draft on this email's thread as it is in Gmail now, plus the two signatures. */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f]{10,24}$/i.test(id)) return fail({ code: 'invalid_input', message: 'Bad id.' });
  if (!s.integration || s.auth.isDemo) {
    return NextResponse.json({
      ok: true,
      draft: null,
      draftError: null,
      canSend: false,
      signatures: { nick: null, arwin: htmlToPlainText(ARWIN_SIGNATURE_HTML) },
    });
  }
  const store = getStore();
  const [draft, nickSignature] = await Promise.all([
    readLiveDraft(store, s.integration, id),
    readPrimarySignature(store, s.integration),
  ]);
  return NextResponse.json(
    {
      ok: true,
      draft: draft.ok ? draft.value : null,
      draftError: draft.ok ? null : draft.error.message,
      canSend: canSend(s.integration),
      // Previews only, as plain text; the HTML is what actually sends.
      signatures: {
        nick: nickSignature ? htmlToPlainText(nickSignature) : null,
        arwin: htmlToPlainText(ARWIN_SIGNATURE_HTML),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
