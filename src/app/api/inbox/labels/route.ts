import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { canSend, createLabel } from '@/lib/google/gmail-send';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { forgetLabelNames } from '@/lib/services/inbox-live';

export const dynamic = 'force-dynamic';

const BODY = z.object({ name: z.string().trim().min(1).max(225) });

/** A new Gmail label of the person's own, from the nav's "+" (a tap). Never deletes a label. */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-labels:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Name the label first.' });
  if (s.auth.isDemo) {
    return fail({ code: 'forbidden', message: "The demo's labels are fixed." }, 409);
  }
  if (!s.integration || !canSend(s.integration)) {
    return fail(
      { code: 'forbidden', message: 'Creating labels needs sending turned on. Do it in Gmail.' },
      409,
    );
  }
  const made = await createLabel(getStore(), s.integration, parsed.data.name);
  if (!made.ok) return fail(made.error);
  forgetLabelNames();
  return NextResponse.json({ ok: true, label: made.value });
}
