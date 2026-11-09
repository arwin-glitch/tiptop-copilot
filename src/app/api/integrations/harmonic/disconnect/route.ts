import { NextResponse, type NextRequest } from 'next/server';
import { authOrError, hasRole } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { harmonicDisconnect } from '@/lib/integrations/harmonic-mcp';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Forgets the Harmonic connection for the whole organization. Admins only. */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  // A plain form post: refuse one sent from any other site.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(env().appUrl).origin) {
    return NextResponse.json(
      { ok: false, error: { code: 'forbidden', message: 'Cross-site request refused.' } },
      { status: 403 },
    );
  }
  if (!hasRole(auth.value, 'admin')) return settingsRedirect('forbidden');

  const store = getStore();
  await harmonicDisconnect(store, auth.value.organizationId);
  await recordAudit(store, {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'integration.disconnected',
    entityType: 'integration',
    entityId: null,
    metadata: { provider: 'harmonic' },
  });
  return settingsRedirect('disconnected');
}

function settingsRedirect(outcome: string): NextResponse {
  return NextResponse.redirect(
    `${env().appUrl}/settings?tab=integrations&harmonic=${outcome}`,
    303,
  );
}
