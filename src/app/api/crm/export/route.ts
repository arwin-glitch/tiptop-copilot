import { NextResponse } from 'next/server';
import { authOrError, requireRole } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor } from '@/lib/services/crm';
import { exportEverything } from '@/lib/services/crm-views';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const fail = (error: AppError) =>
  NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

/**
 * "Export everything": every list, entry, company, person and note as a ZIP
 * of CSVs. The whole CRM in one file, so owners only, a few times an hour at
 * most, and audited (counts only — never a value from the data).
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const role = requireRole(auth.value, 'owner');
  if (!role.ok) return fail(role.error);
  const limited = rateLimit(`crm-export-all:${auth.value.organizationId}`, 5, 10 * 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await exportEverything(
    getStore(),
    auth.value.organizationId,
    crmActor(auth.value),
  );
  if (!result.ok) return fail(result.error);

  const { data, filename } = result.value;
  // A fresh ArrayBuffer of exactly the archive's bytes for the response body.
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
