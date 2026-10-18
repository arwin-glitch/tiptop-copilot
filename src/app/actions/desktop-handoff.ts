'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { rejectHandoff } from '@/lib/auth/desktop-handoff';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';

/**
 * "I didn't start this", from the code page in the system browser.
 *
 * A server action rather than a route handler so Next.js's built-in Server
 * Action origin check acts as CSRF protection, as in actions/session.ts. The
 * redirects stay outside any try/catch: `redirect` works by throwing.
 */
export async function rejectDesktopSignInAction(form: FormData): Promise<void> {
  if (!rateLimit(`desktop-handoff-reject:${addressKey(await headers())}`, 10, 60_000).ok) {
    redirect('/desktop/done?result=busy');
  }
  const handoffId = form.get('h');
  let result: 'cancelled' | 'too_late' | 'expired' | 'unavailable';
  try {
    const outcome = await rejectHandoff(
      getStore(),
      typeof handoffId === 'string' ? handoffId : null,
    );
    if (!outcome.ok) result = 'unavailable';
    else if (outcome.value === 'finished') result = 'too_late';
    else if (outcome.value === 'expired') result = 'expired';
    else result = 'cancelled';
  } catch {
    result = 'unavailable';
  }
  redirect(`/desktop/done?result=${result}`);
}
