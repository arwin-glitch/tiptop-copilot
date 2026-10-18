import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { opensInline } from '@/lib/email/attachment-types';
import { readAttachment } from '@/lib/google/gmail-inbox';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/** One attachment from Nick's mail, read-only. */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const params = request.nextUrl.searchParams;
  const messageId = params.get('m') ?? '';
  const attachmentId = params.get('a') ?? '';
  const name = (params.get('name') ?? 'attachment').replace(/[^\w.\- ()]+/g, '_').slice(0, 120);
  const type = (params.get('type') ?? '').toLowerCase();
  if (!/^[0-9a-f]{10,24}$/i.test(messageId) || !/^[\w-]{10,1000}$/.test(attachmentId)) {
    return fail({ code: 'invalid_input', message: 'Bad attachment link.' });
  }
  if (!s.integration || s.auth.isDemo) {
    return fail({ code: 'not_found', message: 'Attachments open only on the real mailbox.' });
  }
  const file = await readAttachment(getStore(), s.integration, messageId, attachmentId);
  if (!file.ok) return fail(file.error);
  // Types a browser may show in a tab; everything else downloads.
  const inline = opensInline(type);
  return new NextResponse(new Uint8Array(file.value), {
    headers: {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
