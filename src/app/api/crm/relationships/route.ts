import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import {
  RELATIONSHIP_BATCH_MAX,
  relationshipRowsForRecords,
  relationshipScope,
} from '@/lib/services/relationships';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const fail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: NO_STORE },
  );

const IDS = z.array(z.uuid()).min(1).max(RELATIONSHIP_BATCH_MAX);

/**
 * Relationship strength and smart fields (first/last email, last/next
 * meeting, last contact) for one page of CRM records: `?ids=a,b,c`. What a
 * list's optional relationship columns show. Read-only, from the cached
 * relationship index — never a Gmail call per row.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`crm-relationships:${auth.value.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error, 429);

  const raw = request.nextUrl.searchParams.get('ids') ?? '';
  const ids = IDS.safeParse(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!ids.success) return fail(err('invalid_input', 'Ask about 1 to 100 records by id.').error);

  const store = getStore();
  const { organizationId, profile } = auth.value;
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  const rows = await relationshipRowsForRecords(store, organizationId, ids.data, {
    ...relationshipScope(profile.email, integration),
    timeZone: profile.timezone,
  });
  if (!rows.ok) return fail(rows.error);
  return NextResponse.json({ ok: true, rows: rows.value }, { headers: NO_STORE });
}
