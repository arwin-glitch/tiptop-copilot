import { NextResponse } from 'next/server';
import { authOrError, requireRole } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor } from '@/lib/services/crm';
import { exportRecordNotesCsv } from '@/lib/services/crm-views';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const fail = (error: AppError) =>
  NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

/** A company's or person's notes as a CSV, newest first. Members and above; audited, never logged. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const role = requireRole(auth.value, 'member');
  if (!role.ok) return fail(role.error);
  const limited = rateLimit(`crm-export:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);

  const { id } = await context.params;
  const result = await exportRecordNotesCsv(
    getStore(),
    auth.value.organizationId,
    id,
    crmActor(auth.value),
  );
  if (!result.ok) return fail(result.error);

  return new NextResponse(result.value.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.value.filename}"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(result.value.rows),
    },
  });
}
