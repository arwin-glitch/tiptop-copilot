import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { opensInline } from '@/lib/email/attachment-types';
import { readAttachment } from '@/lib/google/gmail-inbox';
import { demoAttachment } from '@/lib/demo/attachment-fixtures';
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
  let bytes: Buffer;
  let mime = type;
  if (s.auth.isDemo) {
    // The demo's fictional files only; nothing reaches Gmail.
    const demo = demoAttachment(attachmentId);
    if (!demo) return fail({ code: 'not_found', message: 'That attachment is not in the demo.' });
    bytes = Buffer.from(demo.base64, 'base64');
    mime = demo.mimeType;
  } else {
    if (!s.integration) {
      return fail({ code: 'not_found', message: 'Attachments open only on the real mailbox.' });
    }
    const file = await readAttachment(getStore(), s.integration, messageId, attachmentId);
    if (!file.ok) return fail(file.error);
    bytes = file.value;
  }
  // Types a browser may show in a tab; everything else downloads.
  const inline = opensInline(mime);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
