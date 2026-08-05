import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { deleteSyncedEmail } from '@/lib/services/inbox';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Deletes every synchronised mailbox record for the caller's organization. */
export async function POST() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const limited = rateLimit(`delete-data:${auth.value.organizationId}`, 3, 300_000);
  if (!limited.ok) {
    return NextResponse.json({ ok: false, error: limited.error }, { status: 429 });
  }

  const result = await deleteSyncedEmail(auth.value);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: statusForError(result.error.code) },
    );
  }
  return NextResponse.json({ ok: true, deleted: result.value.deleted });
}
