'use server';

import { redirect } from 'next/navigation';
import { endSession, getAuthContext, startDemoSession } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';

/**
 * Session entry and exit.
 *
 * These are server actions rather than route handlers so Next.js's built-in
 * Server Action origin check acts as CSRF protection — a cross-site POST cannot
 * invoke them.
 */

export async function enterDemoAction(): Promise<void> {
  if (!isDemoMode()) {
    throw new Error('Demo entry is only available when DEMO_MODE is enabled.');
  }
  // An abuse brake, not a security control — a shared demo link can be opened
  // by a room full of people at once. Tripping it sends the visitor back to a
  // page that explains the wait; throwing here would render a bare server
  // error with no way forward.
  const limited = rateLimit('demo-entry', 60, 60_000);
  if (!limited.ok) redirect('/login?busy=1');

  await startDemoSession();

  const auth = await getAuthContext();
  if (auth) {
    await recordAudit(getStore(), {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'auth.demo_session_started',
      entityType: 'session',
      entityId: null,
      metadata: {},
    });
  }
  redirect('/today');
}

export async function signOutAction(): Promise<void> {
  const auth = await getAuthContext();
  if (auth) {
    await recordAudit(getStore(), {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'auth.signed_out',
      entityType: 'session',
      entityId: null,
      metadata: {},
    });
  }
  await endSession();
  redirect('/login');
}
