import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { ChatMessage } from '@/lib/types/domain';

/**
 * The read/write halves of the Ask bridge — see
 * `src/app/api/integrations/ask-bridge/webhook/route.ts` for the token-
 * authenticated HTTP surface that calls these, and `ask()` in
 * `src/lib/services/chat.ts` for where a pending row is created.
 *
 * A pending row's question is never stored on the row itself — it is simply
 * the user message immediately before it in the same thread, which `ask()`
 * always inserts first. Looking it up here instead of denormalizing it keeps
 * there being exactly one place a question's text lives.
 */

export interface PendingBridgeQuestion {
  message_id: string;
  thread_id: string;
  deal_id: string | null;
  question: string;
  created_at: string;
}

export async function listPendingBridgeQuestions(
  store: DataStore,
  organizationId: string,
): Promise<PendingBridgeQuestion[]> {
  const pending = (await store.list(
    'chat_messages',
    organizationId,
    { eq: { role: 'assistant', status: 'pending' } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as ChatMessage[];

  const results: PendingBridgeQuestion[] = [];
  const threadMessageCache = new Map<string, ChatMessage[]>();
  const threadDealCache = new Map<string, string | null>();

  for (const p of pending) {
    let threadMessages = threadMessageCache.get(p.thread_id);
    if (!threadMessages) {
      threadMessages = (await store.list(
        'chat_messages',
        organizationId,
        { eq: { thread_id: p.thread_id } },
        { orderBy: [{ field: 'created_at', direction: 'asc' }] },
      )) as ChatMessage[];
      threadMessageCache.set(p.thread_id, threadMessages);
    }
    const idx = threadMessages.findIndex((m) => m.id === p.id);
    const question = idx > 0 ? threadMessages[idx - 1] : null;
    // A pending row with no question before it is a data inconsistency, not
    // something to guess at — skip it rather than send a blank question out.
    if (!question || question.role !== 'user') continue;

    let dealId = threadDealCache.get(p.thread_id);
    if (dealId === undefined) {
      const thread = await store.get('chat_threads', organizationId, p.thread_id);
      dealId = (thread as { deal_id: string | null } | null)?.deal_id ?? null;
      threadDealCache.set(p.thread_id, dealId);
    }

    results.push({
      message_id: p.id,
      thread_id: p.thread_id,
      deal_id: dealId,
      question: question.content,
      created_at: p.created_at,
    });
  }
  return results;
}

export type AnswerBridgeQuestionResult =
  { ok: true } | { ok: false; reason: 'not_found' | 'not_pending' };

export async function answerBridgeQuestion(
  store: DataStore,
  organizationId: string,
  messageId: string,
  answer: string,
): Promise<AnswerBridgeQuestionResult> {
  const existing = (await store.get(
    'chat_messages',
    organizationId,
    messageId,
  )) as ChatMessage | null;
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'pending') return { ok: false, reason: 'not_pending' };

  await store.update('chat_messages', organizationId, messageId, {
    content: answer,
    status: 'answered',
    model: 'claude-code-ask-bridge',
  });
  await store.update('chat_threads', organizationId, existing.thread_id, {
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
}
