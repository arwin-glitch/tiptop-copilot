import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MAX_SIGNATURE_HTML } from '@/lib/email/signature-html';
import { MAX_VACATION_SUBJECT } from '@/lib/email/vacation';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { getVacation, saveVacation } from '@/lib/services/inbox-settings';

export const dynamic = 'force-dynamic';

const INSTANT = z.iso.datetime().nullable();

const BODY = z
  .object({
    enabled: z.boolean(),
    subject: z.string().max(MAX_VACATION_SUBJECT),
    html: z.string().max(MAX_SIGNATURE_HTML),
    contactsOnly: z.boolean(),
    domainOnly: z.boolean(),
    start: INSTANT,
    end: INSTANT,
  })
  .strict();

/** Gmail's vacation responder as it is now (for the banner and the dialog). Read-only. */
export async function GET() {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const read = await getVacation(getStore(), s.auth.isDemo, s.integration);
  if (!read.ok) return fail(read.error);
  return NextResponse.json(
    { ok: true, ...read.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Set the vacation responder: only from a person's Save click in the
 * Vacation responder dialog, after the confirm that says it will auto-reply
 * (or their one-click Turn off). It never forwards mail.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-settings:${s.auth.userId}`, 10, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'Those settings could not be read.' });
  }
  const store = getStore();
  const saved = await saveVacation(store, s.auth.isDemo, s.integration, parsed.data);
  if (!saved.ok) return fail(saved.error);
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: parsed.data.enabled ? 'inbox.vacation_on' : 'inbox.vacation_off',
      entityType: 'gmail_settings',
      entityId: null,
      metadata: { has_end: Boolean(parsed.data.end) },
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, vacation: saved.value });
}
