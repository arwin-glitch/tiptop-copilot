import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { ChatMessage } from '@/lib/types/domain';
import { stripSlackLinks } from '@/lib/util/slack-text';

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
  /**
   * The conversation so far, oldest first: the answered questions and answers
   * before this one in the same thread. Without it a follow-up such as "can
   * you attach the links to those threads?" reaches the routine alone and
   * cannot be answered.
   */
  history: BridgeTurn[];
}

export interface BridgeTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Enough for several follow-ups; small enough for a Slack relay message. */
const HISTORY_TURNS = 8;
const HISTORY_TURN_CHARS = 1_500;
const HISTORY_TOTAL_CHARS = 6_000;

/** The turns before `index`, newest kept first when the budget runs out. */
export function conversationBefore(messages: ChatMessage[], index: number): BridgeTurn[] {
  const turns: BridgeTurn[] = [];
  let budget = HISTORY_TOTAL_CHARS;
  for (let i = index - 1; i >= 0 && turns.length < HISTORY_TURNS; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.status !== 'answered' || !m.content.trim()) continue;
    let content = m.content.trim();
    if (content.length > HISTORY_TURN_CHARS) content = `${content.slice(0, HISTORY_TURN_CHARS)}…`;
    if (content.length > budget) break;
    budget -= content.length;
    turns.unshift({ role: m.role, content });
  }
  return turns;
}

/**
 * The conversation before `messageId` in its thread. Reads the whole thread,
 * not the capped list `ask()` loads for itself: that one holds the oldest 20
 * messages, and a follow-up needs the newest ones.
 */
export async function threadHistoryBefore(
  store: DataStore,
  organizationId: string,
  threadId: string,
  messageId: string,
): Promise<BridgeTurn[]> {
  const messages = (await store.list(
    'chat_messages',
    organizationId,
    { eq: { thread_id: threadId } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as ChatMessage[];
  const index = messages.findIndex((m) => m.id === messageId);
  return conversationBefore(messages, index < 0 ? messages.length : index);
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
      history: conversationBefore(threadMessages, idx - 1),
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
    content: stripSlackLinks(answer),
    status: 'answered',
    model: 'claude-code-ask-bridge',
  });
  await store.update('chat_threads', organizationId, existing.thread_id, {
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
}
