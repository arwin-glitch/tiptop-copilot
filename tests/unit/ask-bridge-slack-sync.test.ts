import { describe, expect, it } from 'vitest';
import {
  toAnswerPayload,
  toQuestionMessageText,
  toQuestionPayload,
} from '../../scripts/ask-bridge-slack-sync.mjs';

/**
 * The Ask-bridge relay's pure half.
 *
 * Two directions, two mistakes that would hurt: treating a human message (the
 * routine's own report, Arwin replying) as a question or an answer, and
 * round-tripping a payload with a field missing that the webhook requires.
 */

const PENDING_QUESTION = {
  message_id: '0b574978-a023-413f-a6bd-8daabd1f6862',
  thread_id: '1e175e68-fd9c-4b85-b51c-7e5f0e5e4078',
  deal_id: null,
  question: 'Any urgent emails?',
  created_at: '2026-09-17T17:54:29.417Z',
};

const ANSWER = {
  message_id: '0b574978-a023-413f-a6bd-8daabd1f6862',
  answer: 'Nothing is on fire, but Finch needs a reply today.',
};

describe('question relay', () => {
  it('round-trips a pending question through its Slack message text', () => {
    const text = toQuestionMessageText(PENDING_QUESTION);
    expect(toQuestionPayload({ ts: '1.1', text })).toEqual(PENDING_QUESTION);
  });

  it('rejects a plain message from Arwin in the same DM', () => {
    expect(toQuestionPayload({ ts: '1.2', text: 'stop including DocuSign items' })).toBeNull();
  });

  it("rejects the routine's own answer message", () => {
    const text = `ASK_ANSWER_V1\n\`${JSON.stringify(ANSWER)}\``;
    expect(toQuestionPayload({ ts: '1.3', text })).toBeNull();
  });

  it('unescapes Slack entities inside the backtick-wrapped JSON', () => {
    const payload = { ...PENDING_QUESTION, question: 'Deals &amp; follow-ups?' };
    const text = toQuestionMessageText(payload);
    expect(toQuestionPayload({ ts: '1.4', text })?.question).toBe('Deals & follow-ups?');
  });

  it('rejects a payload missing a required field', () => {
    const text = 'ASK_QUESTION_V1\n`{"thread_id":"x","question":"y"}`';
    expect(toQuestionPayload({ ts: '1.5', text })).toBeNull();
  });
});

describe('answer relay', () => {
  it('parses a well-formed answer message', () => {
    const text = `ASK_ANSWER_V1\n\`${JSON.stringify(ANSWER)}\``;
    expect(toAnswerPayload({ ts: '2.1', text })).toEqual(ANSWER);
  });

  it("rejects the question relay's own message", () => {
    const text = toQuestionMessageText(PENDING_QUESTION);
    expect(toAnswerPayload({ ts: '2.2', text })).toBeNull();
  });

  it('rejects malformed JSON inside the backticks', () => {
    expect(toAnswerPayload({ ts: '2.3', text: 'ASK_ANSWER_V1\n`{not valid json`' })).toBeNull();
  });

  it('rejects a marker line with no backtick-wrapped JSON', () => {
    expect(toAnswerPayload({ ts: '2.4', text: 'ASK_ANSWER_V1' })).toBeNull();
  });

  it('rejects a payload missing the answer field', () => {
    const text = 'ASK_ANSWER_V1\n`{"message_id":"x"}`';
    expect(toAnswerPayload({ ts: '2.5', text })).toBeNull();
  });
});
