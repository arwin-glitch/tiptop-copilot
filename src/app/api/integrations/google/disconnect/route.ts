import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { revokeAndForget } from '@/lib/google/oauth';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { stopGmailWatch } from '@/lib/services/gmail-watch';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Revokes at Google (best effort) and deletes stored tokens locally always. */
export async function POST() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.value.organizationId);
  if (!integration) {
    return NextResponse.json({ ok: true, revokedRemotely: false, note: 'Nothing was connected.' });
  }

  // Before the token is revoked, while the call can still be authorised.
  // Otherwise Gmail keeps publishing to the topic for a mailbox nobody is
  // watching, and the push endpoint wakes a sleeping instance to do nothing
  // until the registration expires a week later.
  await stopGmailWatch(auth.value, integration);

  const result = await revokeAndForget(store, integration);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: statusForError(result.error.code) },
    );
  }

  await recordAudit(store, {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'integration.disconnected',
    entityType: 'integration',
    entityId: integration.id,
    metadata: { revoked_remotely: result.value.revokedRemotely },
  });

  return NextResponse.json({ ok: true, revokedRemotely: result.value.revokedRemotely });
}
