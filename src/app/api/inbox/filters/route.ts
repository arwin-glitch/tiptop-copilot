import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { FILTER_CATEGORIES } from '@/lib/email/inbox-filters';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { filterAccess, makeFilter, readFilters, removeFilter } from '@/lib/services/inbox-filters';

export const dynamic = 'force-dynamic';

const TEXT = z.string().max(500).default('');

const BODY = z
  .object({
    criteria: z
      .object({
        from: TEXT,
        to: TEXT,
        subject: TEXT,
        hasWords: TEXT,
        doesntHave: TEXT,
        hasAttachment: z.boolean().default(false),
      })
      .strict(),
    // No forward and no delete: the schema has no field for either.
    actions: z
      .object({
        skipInbox: z.boolean().default(false),
        markRead: z.boolean().default(false),
        star: z.boolean().default(false),
        label: z
          .string()
          .regex(/^(Label_[0-9A-Za-z]{1,40})?$/)
          .default(''),
        neverSpam: z.boolean().default(false),
        important: z.enum(['', 'always', 'never']).default(''),
        category: z
          .enum(['', ...FILTER_CATEGORIES.map((c) => c.id)] as [string, ...string[]])
          .default(''),
      })
      .strict(),
    applyExisting: z.boolean().default(false),
  })
  .strict();

/** Whether filters are on, and (when they are) the mailbox's filters and labels. Read-only. */
export async function GET() {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const access = filterAccess(s.auth.isDemo, s.integration);
  if (access.state === 'off' || access.state === 'not_connected') {
    return NextResponse.json(
      { ok: true, access, filters: [], labels: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const read = await readFilters(getStore(), s.auth.isDemo, s.integration);
  if (!read.ok) return fail(read.error);
  return NextResponse.json(
    { ok: true, access, ...read.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Create one filter: only from a person's click on Create in the Create filter dialog. */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-filters:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'That filter could not be read.' });
  }
  const store = getStore();
  const made = await makeFilter(store, s.auth.organizationId, s.auth.isDemo, s.integration, {
    criteria: parsed.data.criteria,
    actions: parsed.data.actions as Parameters<typeof makeFilter>[4]['actions'],
    applyExisting: parsed.data.applyExisting,
  });
  if (!made.ok) return fail(made.error);
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: 'inbox.filter_created',
      entityType: 'gmail_filter',
      entityId: null,
      metadata: { applied: made.value.applied },
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, ...made.value });
}

/** Delete one filter: only from a person's click on Delete in the Filters list. */
export async function DELETE(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-filters:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9A-Za-z_-]{1,120}$/.test(id)) {
    return fail({ code: 'invalid_input', message: 'Unknown filter.' });
  }
  const store = getStore();
  const removed = await removeFilter(store, s.auth.isDemo, s.integration, id);
  if (!removed.ok) return fail(removed.error);
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: 'inbox.filter_deleted',
      entityType: 'gmail_filter',
      entityId: null,
      metadata: {},
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
