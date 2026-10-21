'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import type { FeedbackItem, FeedbackStatus } from '@/lib/feedback/shared';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { recordFeedback, setFeedbackAlerts, setFeedbackStatus } from '@/lib/services/feedback';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * In-app feedback (lib/services/feedback.ts). Sending is open to anyone
 * signed in, from the Ask Arwin panel on any page; marking a note done takes
 * a member or above. Every input is checked by the service, not trusted.
 *
 * Sending revalidates nothing, for the reason `askFromWidgetAction` gives: a
 * Server Action that revalidates re-renders the current route, and the panel
 * sends from every page. The full Ask page refreshes itself after sending.
 */

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

/** The first name the list shows beside a note, as the email session names people. */
function actor(auth: AuthContext) {
  const name =
    auth.profile.full_name?.split(' ')[0] || auth.profile.email.split('@')[0] || 'Someone';
  return { id: auth.userId, name };
}

export async function sendFeedbackAction(input: {
  text: string;
  path?: string | null;
  title?: string | null;
}): Promise<ActionResult<FeedbackItem>> {
  const auth = await requireAuth();
  const limited = rateLimit(`feedback:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);
  // Called from the browser, so the shape is checked rather than trusted.
  if (!input || typeof input !== 'object') {
    return fail({ code: 'invalid_input', message: 'Write what to change first.' });
  }
  const result = await recordFeedback(getStore(), auth.organizationId, actor(auth), {
    text: input.text,
    path: input.path,
    title: input.title,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, data: result.value };
}

export async function setFeedbackStatusAction(
  id: string,
  status: FeedbackStatus,
): Promise<ActionResult> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) return fail(role.error);
  const limited = rateLimit(`feedback-status:${auth.userId}`, 60, 60_000);
  if (!limited.ok) return fail(limited.error);
  const result = await setFeedbackStatus(getStore(), auth.organizationId, actor(auth), {
    id,
    status,
  });
  if (!result.ok) return fail(result.error);
  revalidatePath('/ask');
  return { ok: true };
}

/** Ping this person's computers (desktop alerts) when someone else sends feedback. */
export async function setFeedbackAlertsAction(on: boolean): Promise<ActionResult> {
  const auth = await requireAuth();
  if (typeof on !== 'boolean') return fail({ code: 'invalid_input', message: 'On or off.' });
  const limited = rateLimit(`feedback-alerts:${auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error);
  await setFeedbackAlerts(getStore(), auth.organizationId, auth.userId, on);
  return { ok: true };
}
