import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_CHARS,
  cleanQuestion,
  newPerksAnswerKey,
  parsePerksAnswer,
  perksAnswerKeyMatches,
  perksQuestionText,
  sanitisePerksAnswer,
} from '@/lib/perks-ask/bridge';

/** Entirely fictional ids and content, as everywhere in this repository. */
const QID = '12345678-1234-1234-1234-123456789abc';
const KEY = 'A'.repeat(32);

describe('perksQuestionText', () => {
  it('fences the payload, carries the key, and strips what could break the fence', () => {
    const text = perksQuestionText({
      question_id: QID,
      answer_key: KEY,
      questions: ['What`s <the> deal?', 'And NVIDIA?'],
    });
    expect(text.startsWith('PERKS_QUESTION_V1\n`')).toBe(true);
    expect(text.endsWith('`')).toBe(true);
    const inner = text.slice(text.indexOf('`') + 1, text.lastIndexOf('`'));
    const payload = JSON.parse(inner) as {
      question_id: string;
      answer_key: string;
      questions: string[];
    };
    expect(payload.question_id).toBe(QID);
    expect(payload.answer_key).toBe(KEY);
    expect(payload.questions[0]).not.toContain('`');
    expect(payload.questions[0]).not.toContain('<');
  });

  it('appends the catalog block after the fenced JSON when one is given', () => {
    const text = perksQuestionText(
      { question_id: QID, answer_key: KEY, questions: ['Cloud credits?'] },
      'PERKS_CATALOG_V1 (1 perks; columns)\nacme-cloud | Acme Cloud',
    );
    expect(text).toContain('`\n\nPERKS_CATALOG_V1');
    expect(text.endsWith('acme-cloud | Acme Cloud')).toBe(true);
  });
});

describe('the one-time answer key', () => {
  it('matches only its own hash, and tolerates junk', () => {
    const { key, hash } = newPerksAnswerKey();
    expect(perksAnswerKeyMatches(key, hash)).toBe(true);
    expect(perksAnswerKeyMatches(newPerksAnswerKey().key, hash)).toBe(false);
    expect(perksAnswerKeyMatches(null, hash)).toBe(false);
    expect(perksAnswerKeyMatches(key, null)).toBe(false);
    expect(perksAnswerKeyMatches('short', hash)).toBe(false);
    expect(perksAnswerKeyMatches(key, 'not-a-hash')).toBe(false);
  });
});

describe('cleanQuestion', () => {
  it('caps and flattens', () => {
    expect(cleanQuestion(`a\u0000b\n\nc${'x'.repeat(600)}`).length).toBeLessThanOrEqual(500);
    expect(cleanQuestion(42)).toBe('');
  });
});

describe('parsePerksAnswer', () => {
  it('reads a well-formed relay post, key included', () => {
    const parsed = parsePerksAnswer(
      `PERKS_ANSWER_V1\n\`${JSON.stringify({ question_id: QID, answer_key: KEY, answer: 'Credits galore.' })}\``,
    );
    expect(parsed).toEqual({ question_id: QID, answer_key: KEY, answer: 'Credits galore.' });
  });

  it('reads a post without a key as key null (settle then refuses it)', () => {
    const parsed = parsePerksAnswer(
      `PERKS_ANSWER_V1\n\`${JSON.stringify({ question_id: QID, answer: 'No key here.' })}\``,
    );
    expect(parsed?.answer_key).toBeNull();
  });

  it('rejects the wrong marker, a bad id, and junk', () => {
    expect(parsePerksAnswer('BOOKING_ANSWER_V1\n`{}`')).toBeNull();
    expect(
      parsePerksAnswer(`PERKS_ANSWER_V1\n\`${JSON.stringify({ question_id: 'x', answer: 'y' })}\``),
    ).toBeNull();
    expect(parsePerksAnswer('PERKS_ANSWER_V1 no fence')).toBeNull();
  });
});

describe('sanitisePerksAnswer', () => {
  it('keeps perks links and arwin@tiptop.vc, strips everything else', () => {
    const out = sanitisePerksAnswer(
      'See https://perks.tiptop.vc/perk.html?p=acme-cloud or email arwin@tiptop.vc - ' +
        'not pat@evil.example, not https://evil.example/steal, not +1 (555) 010-0199.',
    );
    expect(out).toContain('https://perks.tiptop.vc/perk.html?p=acme-cloud');
    expect(out).toContain('arwin@tiptop.vc');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('555');
  });

  it('flattens markup and caps the length', () => {
    const out = sanitisePerksAnswer(`**Bold** \`code\` <b>tag</b> ${'word '.repeat(400)}`);
    expect(out).not.toContain('*');
    expect(out).not.toContain('<');
    expect((out ?? '').length).toBeLessThanOrEqual(ANSWER_MAX_CHARS);
  });

  it('returns null when nothing is left', () => {
    expect(sanitisePerksAnswer('https://evil.example/only-a-link')).toBeNull();
    expect(sanitisePerksAnswer(42)).toBeNull();
  });
});
