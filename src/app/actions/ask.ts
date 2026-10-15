'use server';

import { requireAuth } from '@/lib/auth/session';
import { rateLimit } from '@/lib/security/limits';
import { ask, readThreadView } from '@/lib/services/chat';
import type { ChatMessage } from '@/lib/types/domain';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * The Ask Arwin widget's one write: ask a question.
 *
 * Its own action rather than `askAction`, for one reason: `askAction`
 * revalidates `/ask`, and a Server Action that revalidates re-renders the
 * *current* route in its response. The widget asks from every page, so each
 * question would re-render Today (or wherever Nick is) for nothing. The Ask
 * page is force-dynamic, so it needs no revalidation to show the new thread.
 * Same service, same rate-limit bucket as the Ask page.
 */

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

export interface WidgetAskResult {
  threadId: string;
  messages: ChatMessage[];
  deal: { id: string; name: string } | null;
}

export async function askFromWidgetAction(
  question: string,
  options: { threadId?: string; dealId?: string } = {},
): Promise<ActionResult<WidgetAskResult>> {
  const auth = await requireAuth();
  // Called from the browser, so the shape is checked rather than trusted.
  if (typeof question !== 'string') {
    return fail({ code: 'invalid_input', message: 'Ask a question first.' });
  }
  const threadId = typeof options?.threadId === 'string' ? options.threadId : null;
  const dealId = typeof options?.dealId === 'string' ? options.dealId : null;

  const limited = rateLimit(`ask:${auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);

  const asked = await ask(auth, question, { threadId, dealId });
  if (!asked.ok) return fail(asked.error);

  // The conversation as stored, so the widget shows exactly what the Ask page
  // would: in production the answer is a pending row the widget then polls.
  const view = await readThreadView(auth, { threadId: asked.value.thread.id }, { settle: false });
  const messages = view.ok
    ? view.value.messages
    : [asked.value.userMessage, asked.value.assistantMessage];
  return {
    ok: true,
    data: {
      threadId: asked.value.thread.id,
      messages,
      deal: view.ok ? view.value.deal : null,
    },
  };
}
