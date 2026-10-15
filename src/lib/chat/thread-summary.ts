import type { ChatMessage, ChatThread } from '@/lib/types/domain';
import { stripSlackLinks } from '@/lib/util/slack-text';
import { snippet as collapse } from '@/lib/util/text';
import { formatMonthDay, formatTime } from '@/lib/util/time';

/**
 * One row of the Ask Arwin history list: the question it was about, where it
 * stands, the last thing said in it and when it started.
 *
 * Pure, and free of `server-only`, so the service that builds the rows and the
 * widget that draws them agree on one shape and one set of words.
 */

/**
 * Where a conversation stands, read off its last message.
 *
 * - `waiting`: the last answer is still on its way (the Slack routine answers
 *   asynchronously, usually within a couple of minutes).
 * - `answered`: the last message is an answer.
 * - `unanswered`: the last question never got one (the answer failed), or the
 *   conversation has no messages at all.
 */
export type ThreadStatus = 'answered' | 'waiting' | 'unanswered';

export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  answered: 'Answered',
  waiting: 'Waiting',
  unanswered: 'No answer',
};

export interface ThreadSummary {
  id: string;
  title: string;
  dealId: string | null;
  startedAt: string;
  lastActivityAt: string;
  status: ThreadStatus;
  /** The last thing said, on one line. */
  snippet: string;
  /** Who said it; null when there is nothing to quote and the title stands in. */
  snippetFrom: 'you' | 'arwin' | null;
}

const SNIPPET_MAX = 140;

/**
 * Summaries for `threads`, in the order given. `messages` may hold any mix of
 * those threads' messages, in any order; messages for other threads are
 * ignored.
 */
export function summarizeThreads(
  threads: readonly ChatThread[],
  messages: readonly ChatMessage[],
): ThreadSummary[] {
  const byThread = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.thread_id);
    if (list) list.push(m);
    else byThread.set(m.thread_id, [m]);
  }

  return threads.map((thread): ThreadSummary => {
    const ordered = (byThread.get(thread.id) ?? [])
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = ordered[ordered.length - 1];
    const lastQuestion = [...ordered].reverse().find((m) => m.role === 'user');

    const base = {
      id: thread.id,
      title: thread.title,
      dealId: thread.deal_id,
      startedAt: thread.created_at,
      lastActivityAt:
        last && last.created_at > thread.updated_at ? last.created_at : thread.updated_at,
    };

    if (!last) {
      return { ...base, status: 'unanswered', snippet: oneLine(thread.title), snippetFrom: null };
    }
    if (last.role === 'assistant' && last.status === 'pending') {
      return {
        ...base,
        status: 'waiting',
        snippet: oneLine(lastQuestion?.content ?? thread.title),
        snippetFrom: 'you',
      };
    }
    if (last.role === 'assistant') {
      const text = oneLine(firstLine(last.content));
      return {
        ...base,
        status: 'answered',
        snippet: text || 'Answered',
        snippetFrom: 'arwin',
      };
    }
    return { ...base, status: 'unanswered', snippet: oneLine(last.content), snippetFrom: 'you' };
  });
}

/** The first non-empty line: an answer's first line is the direct answer. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

function oneLine(text: string): string {
  return collapse(stripSlackLinks(text), SNIPPET_MAX);
}

/**
 * The second line of a history row, under its question: the last thing said,
 * or null when that would only repeat the question (a question still waiting,
 * or one that never got an answer).
 */
export function historyLine(
  summary: Pick<ThreadSummary, 'title' | 'snippet' | 'snippetFrom'>,
): { from: 'you' | 'arwin'; text: string } | null {
  if (!summary.snippetFrom || !summary.snippet) return null;
  if (summary.snippetFrom === 'you') {
    const question = comparable(summary.title);
    const said = comparable(summary.snippet);
    if (question && (said.startsWith(question) || question.startsWith(said))) return null;
  }
  return { from: summary.snippetFrom, text: summary.snippet };
}

/** Either side may be clipped with "…"; case and spacing aside. */
function comparable(text: string): string {
  return text.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "Started Oct 12 at 10:12 AM", in the reader's timezone. */
export function startedLabel(iso: string, timeZone: string): string {
  return `Started ${formatMonthDay(iso, timeZone)} at ${formatTime(iso, timeZone)}`;
}
