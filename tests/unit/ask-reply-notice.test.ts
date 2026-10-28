import { describe, expect, it } from 'vitest';
import {
  ARWIN_AI_NAME,
  EMPTY_REPLY_STATE,
  REPLY_DEFER_MAX_MS,
  arriveReply,
  dismissReply,
  newestArrival,
  parseSeen,
  rememberSeen,
  replyAnnouncement,
  replyArrival,
  replyHeadline,
  replyPreview,
  resumeReplies,
  suspendReplies,
  titleWithCount,
  viewedThread,
  type ReplyArrival,
  type ReplyContext,
} from '@/lib/chat/reply-notice';
import type { ChatMessage } from '@/lib/types/domain';

/**
 * The Ask Arwin "Arwin replied" pop-up: what it previews, and when it shows.
 * All names, ids and answers are invented.
 */

const NOW = Date.parse('2026-10-16T15:00:00.000Z');

function arrival(answerId: string, threadId: string, over: Partial<ReplyArrival> = {}) {
  return {
    answerId,
    threadId,
    preview: `Answer ${answerId}`,
    question: `Question in ${threadId}?`,
    at: NOW,
    ...over,
  } satisfies ReplyArrival;
}

function context(over: Partial<ReplyContext> = {}): ReplyContext {
  return { onScreenThreadId: null, tabHidden: false, tourRunning: false, now: NOW, ...over };
}

let seq = 0;
function message(
  role: ChatMessage['role'],
  content: string,
  over: Partial<ChatMessage> = {},
): ChatMessage {
  seq++;
  return {
    id: `m-${seq}`,
    organization_id: 'org-demo',
    thread_id: 't-demo',
    role,
    content,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    status: 'answered',
    created_at: new Date(NOW + seq * 1_000).toISOString(),
    ...over,
  };
}

describe('replyPreview', () => {
  it("is the answer's first line, plain", () => {
    expect(
      replyPreview('Two follow-ups are overdue.\n\nEvidence\n• Lumen Fold reply [Email]'),
    ).toBe('Two follow-ups are overdue.');
  });

  it('strips Markdown, Slack markup and citation markers', () => {
    expect(
      replyPreview(
        '## **Harbor Bloom** sent the _deck_ [1] — see [the thread](https://mail.example/x) and <https://slack.example/a|Slack> `now`',
      ),
    ).toBe('Harbor Bloom sent the deck — see the thread and Slack now');
    expect(replyPreview('- *Yes:* the wire cleared [^2] [uncited]')).toBe('Yes: the wire cleared');
  });

  it('leaves arithmetic and snake_case alone', () => {
    expect(replyPreview('3 * 4 = 12, per follow_up_id')).toBe('3 * 4 = 12, per follow_up_id');
  });

  it('skips blank lines, bare markup and code fences to find the first words', () => {
    expect(replyPreview('\n\n```\nconst x = 1;\n```\n> **Quarry Bay** replied.')).toBe(
      'Quarry Bay replied.',
    );
    expect(replyPreview('   \n**  **\nNo reply yet.')).toBe('No reply yet.');
    expect(replyPreview('   \n**  **\n')).toBe('');
    expect(replyPreview('')).toBe('');
  });

  it('clips to about 70 characters with an ellipsis', () => {
    const long =
      'The Fenwick Labs board pack arrived on Tuesday and the revenue line is up eleven percent on the quarter.';
    const preview = replyPreview(long);
    expect(preview.length).toBeLessThanOrEqual(70);
    expect(preview.endsWith('…')).toBe(true);
    expect(long.startsWith(preview.slice(0, -1))).toBe(true);
  });
});

describe('replyArrival', () => {
  it('is null while the answer is still on its way', () => {
    const messages = [
      message('user', 'Anything from Harbor Bloom?'),
      message('assistant', '', { status: 'pending' }),
    ];
    expect(replyArrival('t-demo', messages, NOW)).toBeNull();
    expect(replyArrival('t-demo', [], NOW)).toBeNull();
    expect(replyArrival('t-demo', [message('user', 'Hello?')], NOW)).toBeNull();
  });

  it('names the answer, its first line and the question it answers', () => {
    const answer = message('assistant', 'Yes: the deck came in Monday.\n\nEvidence\n• …');
    const messages = [
      message('user', 'Earlier question?'),
      message('assistant', 'Earlier answer.'),
      message('user', 'Did  Harbor Bloom\nsend the deck?'),
      answer,
    ];
    expect(replyArrival('t-demo', messages, NOW)).toEqual({
      answerId: answer.id,
      threadId: 't-demo',
      preview: 'Yes: the deck came in Monday.',
      question: 'Did Harbor Bloom send the deck?',
      at: NOW,
    });
  });
});

describe('arriveReply', () => {
  it('shows a pop-up for an answer that lands out of sight', () => {
    const { state, outcome } = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context());
    expect(outcome).toBe('show');
    expect(state.current?.arrivals.map((a) => a.answerId)).toEqual(['a1']);
    expect(state.seen).toEqual(['a1']);
  });

  it('never shows one for the conversation already on screen', () => {
    const { state, outcome } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a1', 't1'),
      context({ onScreenThreadId: 't1' }),
    );
    expect(outcome).toBe('on-screen');
    expect(state.current).toBeNull();
    expect(state.deferred).toBeNull();
    // Remembered, so a later check cannot pop it up either.
    expect(arriveReply(state, arrival('a1', 't1'), context()).outcome).toBe('seen');
  });

  it('shows another conversation while one is on screen', () => {
    const { outcome } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a2', 't2'),
      context({ onScreenThreadId: 't1' }),
    );
    expect(outcome).toBe('show');
  });

  it('never repeats an answer it has already handled', () => {
    const first = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context());
    const dismissed = dismissReply(first.state);
    const again = arriveReply(dismissed, arrival('a1', 't1'), context());
    expect(again.outcome).toBe('seen');
    expect(again.state).toBe(dismissed);
    expect(again.state.current).toBeNull();
  });

  it('folds answers that land close together into one pop-up that opens the newest', () => {
    const one = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context());
    const two = arriveReply(one.state, arrival('a2', 't2'), context());
    expect(two.outcome).toBe('grouped');
    const notice = two.state.current;
    expect(notice?.arrivals).toHaveLength(2);
    if (!notice) return;
    expect(newestArrival(notice).threadId).toBe('t2');
    expect(replyHeadline(notice)).toBe('Arwin replied to 2 questions');
    expect(replyAnnouncement(notice)).toBe('Arwin replied to 2 questions. Newest: Answer a2');
  });

  it('names the assistant "Arwin (AI)" where no tag can sit beside the name', () => {
    expect(ARWIN_AI_NAME).toBe('Arwin (AI)');
    const one = { arrivals: [arrival('a1', 't1')] };
    const two = { arrivals: [arrival('a1', 't1'), arrival('a2', 't2')] };
    expect(replyHeadline(one, ARWIN_AI_NAME)).toBe('Arwin (AI) replied');
    expect(replyHeadline(two, ARWIN_AI_NAME)).toBe('Arwin (AI) replied to 2 questions');
    // The page draws its own tag, so its words keep the plain name.
    expect(replyHeadline(one)).toBe('Arwin replied');
  });

  it('holds the pop-up while the tab is hidden and counts it for the title', () => {
    const hidden = context({ tabHidden: true });
    const one = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), hidden);
    expect(one.outcome).toBe('deferred');
    expect(one.state.current).toBeNull();
    expect(one.state.deferred?.arrivals).toHaveLength(1);
    expect(one.state.hiddenCount).toBe(1);

    // Back within ten minutes: it shows then, and the title count clears.
    const back = resumeReplies(one.state, context({ now: NOW + 5 * 60_000 }));
    expect(back.current?.arrivals.map((a) => a.answerId)).toEqual(['a1']);
    expect(back.deferred).toBeNull();
    expect(back.hiddenCount).toBe(0);
  });

  it('leaves an answer held longer than ten minutes to the launcher dot', () => {
    const { state } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a1', 't1'),
      context({ tabHidden: true }),
    );
    const late = resumeReplies(state, context({ now: NOW + REPLY_DEFER_MAX_MS + 1 }));
    expect(late.current).toBeNull();
    expect(late.deferred).toBeNull();
    expect(late.hiddenCount).toBe(0);
  });

  it('counts an on-screen answer in a hidden tab for the title, with no pop-up', () => {
    const { state, outcome } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a1', 't1'),
      context({ tabHidden: true, onScreenThreadId: 't1' }),
    );
    expect(outcome).toBe('on-screen');
    expect(state.hiddenCount).toBe(1);
    expect(resumeReplies(state, context({ onScreenThreadId: 't1' })).current).toBeNull();
  });

  it('stays held while the tab is still hidden', () => {
    const { state } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a1', 't1'),
      context({ tabHidden: true }),
    );
    expect(resumeReplies(state, context({ tabHidden: true }))).toBe(state);
  });

  it('drops a held answer whose conversation is on screen by the time it would show', () => {
    const { state } = arriveReply(
      EMPTY_REPLY_STATE,
      arrival('a1', 't1'),
      context({ tabHidden: true }),
    );
    expect(resumeReplies(state, context({ onScreenThreadId: 't1' })).current).toBeNull();
  });

  it('waits for a guided tour to end', () => {
    const touring = context({ tourRunning: true });
    const { state, outcome } = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), touring);
    expect(outcome).toBe('deferred');
    expect(state.hiddenCount).toBe(0);
    expect(resumeReplies(state, touring)).toEqual(state);
    expect(resumeReplies(state, context()).current?.arrivals).toHaveLength(1);
  });

  it('steps a showing pop-up aside when a tour starts, and brings it back after', () => {
    const { state } = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context());
    const suspended = suspendReplies(state);
    expect(suspended.current).toBeNull();
    expect(suspended.deferred?.arrivals).toHaveLength(1);
    expect(resumeReplies(suspended, context()).current?.arrivals).toHaveLength(1);
    expect(suspendReplies(EMPTY_REPLY_STATE)).toBe(EMPTY_REPLY_STATE);
  });

  it('a held pop-up joins one already showing rather than stacking', () => {
    const shown = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context()).state;
    const held = arriveReply(shown, arrival('a2', 't2'), context({ tourRunning: true })).state;
    const resumed = resumeReplies(held, context());
    expect(resumed.current?.arrivals.map((a) => a.answerId)).toEqual(['a1', 'a2']);
    expect(resumed.deferred).toBeNull();
  });
});

describe('viewedThread', () => {
  it('drops what points at a conversation once it is opened', () => {
    const one = arriveReply(EMPTY_REPLY_STATE, arrival('a1', 't1'), context()).state;
    const two = arriveReply(one, arrival('a2', 't2'), context()).state;
    const viewed = viewedThread(two, 't2');
    expect(viewed.current?.arrivals.map((a) => a.answerId)).toEqual(['a1']);
    if (viewed.current) expect(replyHeadline(viewed.current)).toBe('Arwin replied');
    expect(viewedThread(viewed, 't1').current).toBeNull();
    expect(viewedThread(viewed, 't9')).toBe(viewed);
  });
});

describe('words, title and memory', () => {
  it('announces the answer it previews', () => {
    expect(replyAnnouncement({ arrivals: [arrival('a1', 't1')] })).toBe('Arwin replied: Answer a1');
    expect(replyAnnouncement({ arrivals: [arrival('a1', 't1', { preview: '' })] })).toBe(
      'Arwin replied.',
    );
  });

  it('puts the count in front of the title, and takes it off again', () => {
    expect(titleWithCount('Today · TipTop Kraken', 1)).toBe('(1) Today · TipTop Kraken');
    expect(titleWithCount('(1) Today · TipTop Kraken', 2)).toBe('(2) Today · TipTop Kraken');
    expect(titleWithCount('(2) Today · TipTop Kraken', 0)).toBe('Today · TipTop Kraken');
    expect(titleWithCount('Today', 0)).toBe('Today');
  });

  it('remembers a bounded list of answers, newest last', () => {
    let seen: string[] = [];
    for (let i = 0; i < 80; i++) seen = rememberSeen(seen, [`a${i}`]);
    expect(seen).toHaveLength(60);
    expect(seen[seen.length - 1]).toBe('a79');
    expect(rememberSeen(['a1', 'a2'], ['a1'])).toEqual(['a2', 'a1']);
  });

  it('reads stored answer ids defensively', () => {
    expect(parseSeen(null)).toEqual([]);
    expect(parseSeen('not json')).toEqual([]);
    expect(parseSeen('{"a":1}')).toEqual([]);
    expect(parseSeen('["a1", 2, "a3"]')).toEqual(['a1', 'a3']);
  });
});
