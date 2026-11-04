import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { deleteTemplate, listTemplates, saveTemplate } from '@/lib/services/inbox-templates';

export const dynamic = 'force-dynamic';

const BODY = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject: z.string().max(300).default(''),
    html: z.string().max(200_000).default(''),
  })
  .strict();

/** The compose window's Templates menu: the workspace's templates. Read-only. */
export async function GET() {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const res = await listTemplates(getStore(), s.auth.organizationId);
  if (!res.ok) {
    if (res.error.details?.needsMigration) {
      return NextResponse.json({ ok: true, ready: false, templates: [] });
    }
    return fail(res.error);
  }
  return NextResponse.json(
    { ok: true, ready: true, templates: res.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Templates › Save draft as template: only from a person's click. Never sends. */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-templates:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Name the template first.' });
  const res = await saveTemplate(
    getStore(),
    { organizationId: s.auth.organizationId, userId: s.auth.userId },
    parsed.data,
  );
  if (!res.ok) return fail(res.error);
  return NextResponse.json({ ok: true, template: res.value });
}

/** Templates › Delete template: only from a person's click and its confirm. */
export async function DELETE(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-templates:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return fail({ code: 'invalid_input', message: 'Unknown template.' });
  const res = await deleteTemplate(getStore(), s.auth.organizationId, id);
  if (!res.ok) return fail(res.error);
  return NextResponse.json({ ok: true });
}
