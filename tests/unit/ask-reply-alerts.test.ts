import { describe, expect, it } from 'vitest';
import { ASK_PREVIEW_MAX, askRepliesFrom, askReplyWords } from '@/lib/services/ask-reply-alerts';
import type { ReplyArrival } from '@/lib/chat/reply-notice';
import type { ChatMessage, ChatThread } from '@/lib/types/domain';

/**
 * Ask Arwin answers as desktop alerts, the pure parts (D-058): which answers
 * may alert a computer (recent, after it was turned on, never an old answer
 * in a freshly touched thread), when a question counts as waiting, and how
 * the notification is worded. All data is fictional.
 */

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100';
const USER = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-07T15:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ENABLED_AN_HOUR_AGO = ago(60 * MIN);

const ANSWER = '**Yes.** Fictional Capital leads the round [1].\n\nMore detail follows.';
const PREVIEW = 'Yes. Fictional Capital leads the round.';
const QUESTION = 'Who leads the Example Robotics round?';

function message(
  threadId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: string,
  status: 'answered' | 'pending' = 'answered',
): ChatMessage {
  return {
    id,
    organization_id: ORG,
    thread_id: threadId,
    role,
    content,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    status,
    created_at: createdAt,
  };
}

function thread(id: string, updatedAt: string): ChatThread {
  return {
    id,
    organization_id: ORG,
    user_id: USER,
    title: 'A fictional question',
    deal_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

/**
 * One question and its answer, as the Ask bridge writes them: the answer row
 * dates from the question, and the thread is touched when it is answered.
 */
function asked(options: {
  threadId: string;
  answerId: string;
  askedAt: string;
  answeredAt: string | null;
  answer?: string;
  question?: string;
}): { thread: ChatThread; messages: ChatMessage[] } {
  const { threadId, answerId, askedAt, answeredAt } = options;
  return {
    thread: thread(threadId, answeredAt ?? askedAt),
    messages: [
      message(threadId, `${answerId}-q`, 'user', options.question ?? QUESTION, askedAt),
      message(
        threadId,
        answerId,
        'assistant',
        answeredAt ? (options.answer ?? ANSWER) : '',
        askedAt,
        answeredAt ? 'answered' : 'pending',
      ),
    ],
  };
}

function repliesFor(
  rows: { thread: ChatThread; messages: ChatMessage[] }[],
  enabledAt = ENABLED_AN_HOUR_AGO,
) {
  return askRepliesFrom(
    rows.map((r) => r.thread),
    rows.flatMap((r) => r.messages),
    enabledAt,
    NOW,
  );
}

describe('which answers may alert a computer', () => {
  it('an answer that landed a minute ago: its plain first line and its question', () => {
    const row = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(3 * MIN),
      answeredAt: ago(MIN),
    });
    expect(repliesFor([row])).toEqual({
      arrivals: [
        {
          answerId: 'a-1',
          threadId: 't-1',
          preview: PREVIEW,
          question: QUESTION,
          at: Date.parse(ago(MIN)),
        },
      ],
      waiting: false,
    });
  });

  it('nothing that landed before the computer was turned on, or over ten minutes ago', () => {
    const before = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(8 * MIN),
      answeredAt: ago(6 * MIN),
    });
    expect(repliesFor([before], ago(5 * MIN)).arrivals).toEqual([]);
    const old = asked({
      threadId: 't-2',
      answerId: 'a-2',
      askedAt: ago(13 * MIN),
      answeredAt: ago(11 * MIN),
    });
    expect(repliesFor([old]).arrivals).toEqual([]);
  });

  it('never an old answer in a thread touched just now', () => {
    // Anything that updates the thread row bumps updated_at: a deal deleted
    // from under it, a backfill.
    const stale = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(3 * 24 * 60 * MIN),
      answeredAt: ago(3 * 24 * 60 * MIN),
    });
    stale.thread.updated_at = NOW.toISOString();
    expect(repliesFor([stale])).toEqual({ arrivals: [], waiting: false });
  });

  it('a question asked in the last half hour is waiting, and has no arrival yet', () => {
    const fresh = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(2 * MIN),
      answeredAt: null,
    });
    expect(repliesFor([fresh])).toEqual({ arrivals: [], waiting: true });
    const givenUp = asked({
      threadId: 't-2',
      answerId: 'a-2',
      askedAt: ago(31 * MIN),
      answeredAt: null,
    });
    expect(repliesFor([givenUp])).toEqual({ arrivals: [], waiting: false });
  });

  it('a question whose answer failed is neither waiting nor answered', () => {
    const failed = {
      thread: thread('t-1', ago(MIN)),
      messages: [message('t-1', 'q-1', 'user', QUESTION, ago(MIN))],
    };
    expect(repliesFor([failed])).toEqual({ arrivals: [], waiting: false });
  });

  it('an answer and its question in the same millisecond still read as answered', () => {
    const at = ago(MIN);
    const row = {
      thread: thread('t-1', at),
      // The answer listed first, as a store may return equal timestamps.
      messages: [
        message('t-1', 'a-1', 'assistant', ANSWER, at),
        message('t-1', 'q-1', 'user', QUESTION, at),
      ],
    };
    expect(repliesFor([row]).arrivals).toMatchObject([{ answerId: 'a-1', question: QUESTION }]);
  });

  it('compares times as instants, whatever offset they are written with', () => {
    // 14:59 UTC written as Supabase does, and as Chicago time: as strings,
    // both sort before "2026-10-07T14:59:00.000Z" and "…14:50…".
    const supabase = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: '2026-10-07T14:58:00+00:00',
      answeredAt: '2026-10-07T14:59:00+00:00',
    });
    expect(repliesFor([supabase], '2026-10-07T14:59:00.000Z').arrivals).toHaveLength(1);
    const offset = asked({
      threadId: 't-2',
      answerId: 'a-2',
      askedAt: '2026-10-07T09:58:00-05:00',
      answeredAt: '2026-10-07T09:59:00-05:00',
    });
    expect(repliesFor([offset]).arrivals).toHaveLength(1);
  });

  it('several answers come oldest first', () => {
    const newer = asked({
      threadId: 't-new',
      answerId: 'a-new',
      askedAt: ago(4 * MIN),
      answeredAt: ago(MIN),
    });
    const older = asked({
      threadId: 't-old',
      answerId: 'a-old',
      askedAt: ago(6 * MIN),
      answeredAt: ago(3 * MIN),
    });
    // Threads come newest first from the store.
    expect(repliesFor([newer, older]).arrivals.map((a) => a.answerId)).toEqual(['a-old', 'a-new']);
  });

  it('a follow-up waiting in a thread with an earlier answer is waiting, not answered', () => {
    const first = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(6 * MIN),
      answeredAt: ago(5 * MIN),
    });
    const followUp = asked({
      threadId: 't-1',
      answerId: 'a-2',
      askedAt: ago(MIN),
      answeredAt: null,
    });
    const row = { thread: followUp.thread, messages: [...first.messages, ...followUp.messages] };
    expect(repliesFor([row])).toEqual({ arrivals: [], waiting: true });
  });
});

describe('the notification', () => {
  const arrival = (n: number, overrides: Partial<ReplyArrival> = {}): ReplyArrival => ({
    answerId: `a-${n}`,
    threadId: `0000000${n}-0000-4000-8000-000000000000`,
    preview: PREVIEW,
    question: QUESTION,
    at: n,
    ...overrides,
  });

  it('one answer: "Arwin replied", its first line, and its conversation', () => {
    expect(askReplyWords([arrival(1)])).toEqual({
      keys: ['ask:a-1'],
      title: 'Arwin replied',
      body: PREVIEW,
      url: '/ask?thread=00000001-0000-4000-8000-000000000000',
    });
  });

  it('two answers: one notification for both, opening the newest', () => {
    const newest = arrival(2, { preview: 'No. The round closes next week.' });
    expect(askReplyWords([arrival(1), newest])).toEqual({
      keys: ['ask:a-1', 'ask:a-2'],
      title: 'Arwin replied to 2 questions',
      body: 'No. The round closes next week.',
      url: '/ask?thread=00000002-0000-4000-8000-000000000000',
    });
  });

  it('the question stands in for an answer with no plain first line, then a fixed line', () => {
    expect(askReplyWords([arrival(1, { preview: '' })])?.body).toBe(`You asked: ${QUESTION}`);
    expect(askReplyWords([arrival(1, { preview: '', question: null })])?.body).toBe(
      'The answer is ready to read.',
    );
  });

  it('a code block alone gives no preview, so the question shows', () => {
    const row = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(2 * MIN),
      answeredAt: ago(MIN),
      answer: '```\nfictional_output = 1\n```',
    });
    const words = askReplyWords(repliesFor([row]).arrivals);
    expect(words?.body).toBe(`You asked: ${QUESTION}`);
  });

  it('a long answer is cut to 100 characters', () => {
    const row = asked({
      threadId: 't-1',
      answerId: 'a-1',
      askedAt: ago(2 * MIN),
      answeredAt: ago(MIN),
      answer: 'Fictional '.repeat(30).trim(),
    });
    const body = askReplyWords(repliesFor([row]).arrivals)?.body ?? '';
    expect(body.length).toBeLessThanOrEqual(ASK_PREVIEW_MAX);
    expect(body.endsWith('…')).toBe(true);
  });

  it('opens the Ask page for a thread id the path rule refuses', () => {
    expect(askReplyWords([arrival(1, { threadId: 't-(1)' })])?.url).toBe('/ask');
  });

  it('nothing for no answers', () => {
    expect(askReplyWords([])).toBeNull();
  });
});
