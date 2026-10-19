import 'server-only';
import type { DataStore } from '@/lib/db/store';
import {
  REPLY_DEFER_MAX_MS,
  replyArrival,
  replyHeadline,
  replyPreview,
  type ReplyArrival,
} from '@/lib/chat/reply-notice';
import { isInAppAlertPath } from '@/lib/desktop/shared';
import type { ChatMessage, ChatThread } from '@/lib/types/domain';
import { settleAnswersFromSlack } from './ask-routine';

/**
 * Ask Arwin answers as desktop alerts (desktop 0.4.1, D-058): "Arwin replied"
 * on the computers of whoever asked, worked out when the shell asks, like the
 * rest of desktop-alerts.ts. Nothing is queued.
 *
 * - Who: only the person who asked. A thread's `user_id` is its asker, and a
 *   computer's is whoever turned it on; nobody else's computer, Nick's
 *   included, ever gets the answer.
 * - What: an answer counts when its thread was touched after the computer was
 *   turned on and within the last ten minutes (the in-page pop-up's own
 *   limit), and the answer row itself is at most two hours old. A thread's
 *   `updated_at` is the only "answered at" there is (a bridge answer keeps its
 *   row's `created_at`, the question's time), but any update to the row bumps
 *   it, so the answer's own age keeps a touched old thread from replaying.
 * - How it shows: the answer's first line, plain, as the in-page pop-up
 *   previews it, marked `quietWhenFocused`: the shell shows nothing while the
 *   person is looking at Copilot, where the page says so itself.
 * - When: while the person's own question waits (up to 30 minutes, as the
 *   widget watches), the computer is told to ask again in 30 seconds, day or
 *   night, and each ask first settles answers from the Slack relay.
 */

/** An answer that landed longer ago than this is left to the widget's dot. */
export const ASK_REPLY_RECENT_MS = REPLY_DEFER_MAX_MS;
/**
 * An answer row older than this never alerts, however recently its thread was
 * touched: a bridge answer's row dates from its question, and anything that
 * updates an old thread (a deal deleted from under it) bumps its `updated_at`.
 */
export const ASK_ANSWER_MAX_AGE_MS = 2 * 3_600_000;
/** A question waiting longer than this is no longer watched, as in the widget. */
export const ASK_WAIT_WATCH_MS = 30 * 60_000;
/** How soon a computer asks again while its owner waits: the soonest the shell takes. */
export const ASK_WAIT_POLL_SECONDS = 30;
export const ASK_PREVIEW_MAX = 100;
const THREADS_MAX = 10;
const MESSAGES_MAX = 200;
const KEY_PREFIX = 'ask:';

export interface AskReplies {
  /** Oldest first. */
  arrivals: ReplyArrival[];
  /** One of the person's own questions is waiting for its answer. */
  waiting: boolean;
}

export const NO_ASK_REPLIES: AskReplies = { arrivals: [], waiting: false };

/** The ledger key of one answer. */
export function askReplyKey(answerId: string): string {
  return `${KEY_PREFIX}${answerId}`;
}

function byTime(a: ChatMessage, b: ChatMessage): number {
  const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (diff !== 0) return diff;
  // An answer never comes before its question, even in the same millisecond.
  if (a.role === b.role) return 0;
  return a.role === 'user' ? -1 : 1;
}

/**
 * The answers that may alert one computer, and whether a question is still
 * waiting, from its owner's recent threads and their messages. Times are
 * compared as instants: Supabase writes "+00:00" where JavaScript writes "Z".
 * Pure.
 */
export function askRepliesFrom(
  threads: readonly ChatThread[],
  messages: readonly ChatMessage[],
  enabledAt: string,
  now: Date,
): AskReplies {
  const at = now.getTime();
  const since = Math.max(Date.parse(enabledAt) || 0, at - ASK_REPLY_RECENT_MS);
  const answeredFrom = at - ASK_ANSWER_MAX_AGE_MS;
  const waitFrom = at - ASK_WAIT_WATCH_MS;

  const byThread = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const list = byThread.get(message.thread_id);
    if (list) list.push(message);
    else byThread.set(message.thread_id, [message]);
  }

  let waiting = false;
  const arrivals: ReplyArrival[] = [];
  for (const thread of threads) {
    const threadMessages = [...(byThread.get(thread.id) ?? [])].sort(byTime);
    const last = threadMessages[threadMessages.length - 1];
    // A question whose in-process answer failed ends on the question: it is
    // neither waiting nor answered.
    if (!last || last.role !== 'assistant') continue;
    const created = Date.parse(last.created_at);
    if (last.status === 'pending') {
      if (created >= waitFrom) waiting = true;
      continue;
    }
    const touched = Date.parse(thread.updated_at);
    if (!(touched >= since) || !(created >= answeredFrom)) continue;
    if (!last.content.trim()) continue;
    const arrival = replyArrival(thread.id, threadMessages, touched);
    if (!arrival) continue;
    arrivals.push({ ...arrival, preview: replyPreview(last.content, ASK_PREVIEW_MAX) });
  }
  arrivals.sort((a, b) => a.at - b.at);
  return { arrivals, waiting };
}

/**
 * The person's threads touched in the last half hour (at most ten, on the
 * `chat_threads_user_idx` index) and their newest messages. An idle ask costs
 * the one thread read.
 */
export async function readAskReplies(
  store: DataStore,
  organizationId: string,
  userId: string,
  enabledAt: string,
  now: Date,
): Promise<AskReplies> {
  const threads = await store.list(
    'chat_threads',
    organizationId,
    {
      eq: { user_id: userId },
      gte: { updated_at: new Date(now.getTime() - ASK_WAIT_WATCH_MS).toISOString() },
    },
    { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: THREADS_MAX },
  );
  if (!threads.length) return NO_ASK_REPLIES;
  const messages = await store.list(
    'chat_messages',
    organizationId,
    { in: { thread_id: threads.map((t) => t.id) } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: MESSAGES_MAX },
  );
  return askRepliesFrom(threads, messages, enabledAt, now);
}

/**
 * What one computer's owner has had answered, and whether they are waiting.
 * While they wait, answers already in the Slack relay are settled first, so
 * one that is there pings on this ask rather than after the relay job runs.
 * Settling org-wide is what every page poll already does; a computer's poll
 * does it only while its owner waits.
 */
export async function askRepliesFor(
  store: DataStore,
  caller: { organizationId: string; userId: string; enabledAt: string },
  now: Date,
): Promise<AskReplies> {
  const read = () =>
    readAskReplies(store, caller.organizationId, caller.userId, caller.enabledAt, now);
  const first = await read();
  if (!first.waiting) return first;
  const settled = await settleAnswersFromSlack(store, caller.organizationId);
  return settled > 0 ? read() : first;
}

/**
 * One notification for the answers that landed, as the in-page pop-up groups
 * them: "Arwin replied" (or "Arwin replied to 2 questions"), the newest
 * answer's first line, and a click that opens its conversation. The question
 * stands in when the answer has no plain first line (a code block). Null for
 * none. Pure.
 */
export function askReplyWords(
  arrivals: readonly ReplyArrival[],
): { keys: string[]; title: string; body: string; url: string } | null {
  const newest = arrivals[arrivals.length - 1];
  if (!newest) return null;
  const url = `/ask?thread=${encodeURIComponent(newest.threadId)}`;
  return {
    // At most THREADS_MAX keys, well inside the shell's 50.
    keys: arrivals.map((a) => askReplyKey(a.answerId)),
    title: replyHeadline({ arrivals: [...arrivals] }),
    body:
      newest.preview ||
      (newest.question ? `You asked: ${newest.question}` : 'The answer is ready to read.'),
    url: isInAppAlertPath(url) ? url : '/ask',
  };
}
