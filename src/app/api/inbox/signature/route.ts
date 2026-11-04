import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MAX_SIGNATURE_HTML } from '@/lib/email/signature-html';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { getSignature, saveSignature } from '@/lib/services/inbox-settings';

export const dynamic = 'force-dynamic';

const BODY = z.object({ html: z.string().max(MAX_SIGNATURE_HTML) }).strict();

/** The mailbox's Gmail signature (sanitized) and whether it can be changed here. Read-only. */
export async function GET() {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const read = await getSignature(getStore(), s.auth.isDemo, s.integration);
  if (!read.ok) return fail(read.error);
  return NextResponse.json(
    { ok: true, ...read.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Save the signature: only from a person's Save click in the Signature dialog. */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-settings:${s.auth.userId}`, 10, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'That signature is too long for Gmail.' });
  }
  const store = getStore();
  const saved = await saveSignature(store, s.auth.isDemo, s.integration, parsed.data.html);
  if (!saved.ok) return fail(saved.error);
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: 'inbox.signature_saved',
      entityType: 'gmail_settings',
      entityId: null,
      metadata: {},
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, ...saved.value });
}
