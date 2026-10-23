import { describe, expect, it } from 'vitest';
import {
  bm25Scores,
  pickExcerpts,
  rankTexts,
  resolveBridgeCitations,
  tokenize,
  type RetrievalLine,
} from '@/lib/notes/chat-retrieval';

/**
 * The meeting chat's local retrieval (D-076): which transcript lines a
 * question sends Arwin's routine, picked by a small BM25 ranking within a
 * budget, and how the "[M1.152]" ids in the answer become "[12:31 Dana]"
 * links. No model anywhere. Fictional people and numbers only.
 */

const MEETING = '0a1b2c3d-0000-4000-8000-000000000001';
const OTHER = '0a1b2c3d-0000-4000-8000-000000000002';

const line = (
  seq: number,
  speaker: string,
  text: string,
  meetingIndex = 1,
  meetingId = MEETING,
): RetrievalLine => ({ meetingId, meetingIndex, seq, speaker, startMs: seq * 10_000, text });

const LINES: RetrievalLine[] = [
  line(0, 'Morgan Lee', 'Thanks for joining, everyone knows this call is transcribed.'),
  line(1, 'Morgan Lee', 'What does net revenue retention look like?'),
  line(2, 'Dana Reyes', 'Net revenue retention is 130 percent across 19 customers.'),
  line(3, 'Dana Reyes', 'We deploy in eleven days on average.'),
  line(4, 'Priya Shah', 'Our pilot with a freight company starts next month.'),
  line(5, 'Morgan Lee', "I'll send you an intro to our operations lead by Friday."),
];

describe('ranking', () => {
  it('tokenizes without stop words, with light stemming', () => {
    expect(tokenize('What are the customers saying about pilots?')).toEqual([
      'customer',
      'say',
      'pilot',
    ]);
  });

  it('scores the lines that share the question’s words, rarer words higher', () => {
    const scores = bm25Scores(
      LINES.map((l) => tokenize(l.text)),
      tokenize('retention customers'),
    );
    expect(scores[2]).toBeGreaterThan(scores[1] as number);
    expect(scores[0]).toBe(0);
    expect(
      rankTexts([{ text: 'nothing here' }, { text: 'the pilot starts' }], 'pilot')[0]?.text,
    ).toBe('the pilot starts');
  });
});

describe('picking the excerpts', () => {
  it('sends the best matches with the line before each, in meeting order, ids kept', () => {
    const picked = pickExcerpts(LINES, 'What is the net revenue retention?');
    // Lines 1 and 2 match; line 0 comes along as the line before line 1.
    expect(picked.excerpts.map((e) => e[0])).toEqual(['M1.0', 'M1.1', 'M1.2']);
    expect(picked.excerpts[2]).toEqual([
      'M1.2',
      'Dana Reyes',
      '0:20',
      'Net revenue retention is 130 percent across 19 customers.',
    ]);
    expect(picked.lineMap['M1.2']).toEqual({
      meetingId: MEETING,
      fromSeq: 2,
      toSeq: 2,
      startMs: 20_000,
      speaker: 'Dana Reyes',
    });
  });

  it('stays within the character budget', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      line(i, 'Dana Reyes', `The pilot number ${i} went well with strong retention.`),
    );
    const picked = pickExcerpts(many, 'pilot retention', { budgetChars: 2_000 });
    const size = picked.excerpts.reduce((sum, e) => sum + JSON.stringify(e).length + 1, 0);
    expect(size).toBeLessThanOrEqual(2_000);
    expect(picked.excerpts.length).toBeGreaterThan(5);
  });

  it('samples one meeting evenly for a question with few matching words ("summarize this")', () => {
    const picked = pickExcerpts(LINES, 'Summarize this', { fillEvenly: true });
    expect(picked.matched).toBe(0);
    expect(picked.excerpts.length).toBe(LINES.length);
    expect(pickExcerpts(LINES, 'Summarize this').excerpts).toHaveLength(0);
  });

  it('never lets a backtick into what is sent', () => {
    const picked = pickExcerpts([line(0, 'Dana `D` Reyes', 'run `this` pilot')], 'pilot');
    expect(JSON.stringify(picked.excerpts)).not.toContain('`');
  });
});

describe('citations in the answer', () => {
  const lineMap = {
    'M1.2': { meetingId: MEETING, fromSeq: 2, toSeq: 2, startMs: 20_000, speaker: 'Dana Reyes' },
    'M2.40': { meetingId: OTHER, fromSeq: 40, toSeq: 40, startMs: 754_000, speaker: 'Priya Shah' },
  };

  it('turns ids into "[0:20 Dana Reyes]" labels, lists included, and drops ids never sent', () => {
    const { answer, citations } = resolveBridgeCitations(
      'Retention is 130% [M1.2]. The pilot starts soon [M2.40, M9.9]. Unsure [M3.1] .',
      lineMap,
    );
    expect(answer).toBe(
      'Retention is 130% [0:20 Dana Reyes]. The pilot starts soon [12:34 Priya Shah]. Unsure.',
    );
    expect(citations).toEqual([
      {
        meetingId: MEETING,
        seq: 2,
        startMs: 20_000,
        speaker: 'Dana Reyes',
        label: '[0:20 Dana Reyes]',
      },
      {
        meetingId: OTHER,
        seq: 40,
        startMs: 754_000,
        speaker: 'Priya Shah',
        label: '[12:34 Priya Shah]',
      },
    ]);
  });

  it('reads the same citations from an answer already rewritten with labels', () => {
    const once = resolveBridgeCitations('Retention [M1.2].', lineMap);
    const twice = resolveBridgeCitations(once.answer, lineMap);
    expect(twice).toEqual(once);
  });
});
