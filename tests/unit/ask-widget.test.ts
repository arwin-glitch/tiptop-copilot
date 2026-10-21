import { describe, expect, it } from 'vitest';
import { askRequestFromHref, askRequestFromParam } from '@/lib/chat/ask-link';
import { historyLine, startedLabel, summarizeThreads } from '@/lib/chat/thread-summary';
import type { ChatMessage, ChatThread } from '@/lib/types/domain';

/**
 * The Ask Arwin widget's two pure pieces: the history rows (where each
 * conversation stands, and the last thing said) and the `/ask` links it may
 * catch instead of navigating. All names and ids are invented.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';

function thread(id: string, over: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    organization_id: ORG,
    user_id: '00000000-0000-4000-8000-0000000000bb',
    title: `Question ${id}`,
    deal_id: null,
    created_at: '2026-10-12T15:12:00.000Z',
    updated_at: '2026-10-12T15:12:00.000Z',
    ...over,
  };
}

let seq = 0;
function message(
  threadId: string,
  role: ChatMessage['role'],
  content: string,
  over: Partial<ChatMessage> = {},
): ChatMessage {
  seq++;
  return {
    id: `m-${seq}`,
    organization_id: ORG,
    thread_id: threadId,
    role,
    content,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    status: 'answered',
    created_at: new Date(Date.parse('2026-10-12T15:13:00.000Z') + seq * 60_000).toISOString(),
    ...over,
  };
}

describe('summarizeThreads', () => {
  it('reads an answered conversation off its last answer, first line only', () => {
    const t = thread('t1');
    const rows = summarizeThreads(
      [t],
      [
        message('t1', 'user', 'Which follow-ups are overdue?'),
        message('t1', 'assistant', 'Two are overdue: Lumenfold and Quarry Bay.\n\nEvidence\n• …'),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 't1',
      status: 'answered',
      snippet: 'Two are overdue: Lumenfold and Quarry Bay.',
      snippetFrom: 'arwin',
      startedAt: t.created_at,
    });
  });

  it('marks a conversation waiting while its answer is on the way, quoting the question', () => {
    const rows = summarizeThreads(
      [thread('t2')],
      [
        message('t2', 'user', 'Anything new from Harbor Bloom?'),
        message('t2', 'assistant', '', { status: 'pending' }),
      ],
    );
    expect(rows[0]).toMatchObject({
      status: 'waiting',
      snippet: 'Anything new from Harbor Bloom?',
      snippetFrom: 'you',
    });
  });

  it('marks a question that never got an answer, and an empty thread, as unanswered', () => {
    const rows = summarizeThreads(
      [thread('t3'), thread('t4', { title: 'Started but empty' })],
      [message('t3', 'user', 'Did the wire land?')],
    );
    expect(rows[0]).toMatchObject({ status: 'unanswered', snippetFrom: 'you' });
    expect(rows[1]).toMatchObject({
      status: 'unanswered',
      snippet: 'Started but empty',
      snippetFrom: null,
    });
  });

  it('orders by time whatever order the messages arrive in, and keeps the thread order', () => {
    const q = message('t5', 'user', 'First question');
    const a = message('t5', 'assistant', 'First answer');
    const q2 = message('t5', 'user', 'Follow-up question');
    const rows = summarizeThreads([thread('t6'), thread('t5')], [q2, a, q]);
    expect(rows.map((r) => r.id)).toEqual(['t6', 't5']);
    expect(rows[1]).toMatchObject({ status: 'unanswered', snippet: 'Follow-up question' });
    expect(rows[1]?.lastActivityAt).toBe(q2.created_at);
  });

  it('keeps snippets to one short line, with Slack link markup removed', () => {
    const long = `See <https://mail.example/thread|the thread> ${'and more '.repeat(40)}`;
    const rows = summarizeThreads(
      [thread('t7')],
      [message('t7', 'user', 'Q'), message('t7', 'assistant', long)],
    );
    expect(rows[0]?.snippet.startsWith('See the thread and more')).toBe(true);
    expect(rows[0]?.snippet.length).toBeLessThanOrEqual(140);
    expect(rows[0]?.snippet.endsWith('…')).toBe(true);
  });
});

describe('startedLabel', () => {
  it("says when a conversation started, in the reader's timezone", () => {
    expect(startedLabel('2026-10-12T15:12:00.000Z', 'America/Chicago')).toBe(
      'Started Oct 12 at 10:12 AM',
    );
  });
});

describe('askRequestFromHref', () => {
  const BASE = 'https://copilot.example/today';

  it('reads a prefilled question, a deal scope and a thread', () => {
    expect(
      askRequestFromHref('/ask?q=What%20actually%20needs%20my%20attention%20today%3F', BASE),
    ).toEqual({ question: 'What actually needs my attention today?' });
    expect(
      askRequestFromHref('/ask?deal=00000000-0000-4000-8000-000000000064&q=Research', BASE),
    ).toEqual({ question: 'Research', dealId: '00000000-0000-4000-8000-000000000064' });
    expect(askRequestFromHref('/ask?thread=abc-123', BASE)).toEqual({ threadId: 'abc-123' });
    expect(askRequestFromHref('/ask', BASE)).toEqual({});
  });

  it('leaves every other link alone', () => {
    expect(askRequestFromHref('/asking', BASE)).toBeNull();
    expect(askRequestFromHref('/ask/elsewhere', BASE)).toBeNull();
    expect(askRequestFromHref('/deals?q=ask', BASE)).toBeNull();
    expect(askRequestFromHref('https://other.example/ask?q=hi', BASE)).toBeNull();
    expect(askRequestFromHref('http://[bad', BASE)).toBeNull();
  });

  it('drops ids that are not ids', () => {
    expect(askRequestFromHref('/ask?deal=../../etc&thread=%3Cscript%3E', BASE)).toEqual({});
  });

  it("leaves the full page's other tabs to open as pages", () => {
    expect(askRequestFromHref('/ask?tab=feedback', BASE)).toBeNull();
    expect(askRequestFromHref('/ask?tab=anything&q=Hello', BASE)).toBeNull();
    // The conversation tab is still a request for the widget.
    expect(askRequestFromHref('/ask?tab=conversations', BASE)).toEqual({});
    expect(askRequestFromHref('/ask?tab=conversations&thread=abc-123', BASE)).toEqual({
      threadId: 'abc-123',
    });
  });
});

describe('askRequestFromParam', () => {
  it('opens with the question, or just opens on an empty value', () => {
    expect(askRequestFromParam(null)).toBeNull();
    expect(askRequestFromParam('')).toEqual({});
    expect(askRequestFromParam('  Who owes me a reply?  ')).toEqual({
      question: 'Who owes me a reply?',
    });
  });
});

describe('historyLine', () => {
  it("shows Arwin's answer under the question", () => {
    expect(
      historyLine({
        title: 'Did the Halyard founders reply?',
        snippet: 'Yes, three replied yesterday.',
        snippetFrom: 'arwin',
      }),
    ).toEqual({ from: 'arwin', text: 'Yes, three replied yesterday.' });
  });

  it('shows nothing when the last thing said is the question itself', () => {
    expect(
      historyLine({
        title: 'What is waiting on me?',
        snippet: 'What is waiting  on me?',
        snippetFrom: 'you',
      }),
    ).toBeNull();
    // The title is the question clipped to 70 characters.
    const long =
      'Which of the portfolio companies asked for help with hiring this quarter, and who';
    expect(
      historyLine({ title: `${long.slice(0, 69)}…`, snippet: long, snippetFrom: 'you' }),
    ).toBeNull();
    expect(historyLine({ title: 'Empty', snippet: 'Empty', snippetFrom: null })).toBeNull();
  });

  it('shows a later question that is not the first one', () => {
    expect(
      historyLine({
        title: 'Who owes me a reply?',
        snippet: 'And which of them is an LP?',
        snippetFrom: 'you',
      }),
    ).toEqual({ from: 'you', text: 'And which of them is an LP?' });
  });
});
