import { NextResponse, type NextRequest } from 'next/server';
import { MESSAGE_ID, originalSummary, parseHeaders } from '@/lib/email/raw-message';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { readOriginal } from '@/lib/services/inbox-original';

export const dynamic = 'force-dynamic';

const GMAIL_ID = /^[0-9a-f]{10,24}$/i;

/**
 * Gmail's "Show original" (JSON: the summary, the headers and the source as
 * text, shown escaped and read-only) and "Download message" (`download=1`:
 * the .eml file). Reading never changes anything in Gmail.
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-original:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const params = request.nextUrl.searchParams;
  const thread = params.get('thread') ?? '';
  const id = params.get('id') ?? '';
  if (!GMAIL_ID.test(thread) || !MESSAGE_ID.test(id)) {
    return fail({ code: 'invalid_input', message: 'Unknown message.' });
  }
  const read = await readOriginal(getStore(), s.auth.organizationId, s.integration, thread, id);
  if (!read.ok) return fail(read.error);
  if (params.get('download') === '1') {
    return new NextResponse(new Uint8Array(read.value.bytes), {
      headers: {
        'Content-Type': 'message/rfc822',
        'Content-Disposition': `attachment; filename="${read.value.fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(read.value.fileName)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  // Shown as text: bytes that are not UTF-8 show as replacement marks; the download keeps them.
  const source = read.value.bytes.toString('utf8');
  const headers = parseHeaders(source);
  return NextResponse.json(
    {
      ok: true,
      subject: read.value.subject,
      fileName: read.value.fileName,
      summary: originalSummary(headers),
      source,
      bytes: read.value.bytes.length,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
