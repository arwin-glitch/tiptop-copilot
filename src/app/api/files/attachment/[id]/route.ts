import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStorage, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import type { EmailAttachment } from '@/lib/types/domain';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const SIGNED_URL_TTL_SECONDS = 900; // 15 minutes

/**
 * Mint a short-lived signed URL for a stored attachment.
 *
 * Authorization happens here — the bucket itself is private and has no public
 * path. The URL expires in fifteen minutes and is generated per request, so a
 * leaked link is short-lived and traceable in the audit log.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const { id } = await context.params;
  const store = getStore();
  const attachment = (await store.get(
    'email_attachments',
    auth.value.organizationId,
    id,
  )) as EmailAttachment | null;

  if (!attachment) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'That attachment does not exist.' } },
      { status: 404 },
    );
  }
  if (!attachment.storage_path) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This attachment was not stored — only its extracted text is available.',
        },
      },
      { status: 404 },
    );
  }

  const signed = await getStorage().signedUrl(attachment.storage_path, SIGNED_URL_TTL_SECONDS);
  if (!signed.ok) {
    return NextResponse.json(
      { ok: false, error: signed.error },
      { status: statusForError(signed.error.code) },
    );
  }

  await recordAudit(store, {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'attachment.downloaded',
    entityType: 'email_attachment',
    entityId: id,
    metadata: { filename: attachment.safe_filename, ttl_seconds: SIGNED_URL_TTL_SECONDS },
  });

  return NextResponse.redirect(signed.value, { headers: { 'Cache-Control': 'no-store' } });
}
