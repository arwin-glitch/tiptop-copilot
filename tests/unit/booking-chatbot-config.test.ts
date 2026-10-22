import { describe, expect, it } from 'vitest';
import {
  CHATBOT_CONFIG_PATCH,
  CHATBOT_CONFIG_SCHEMA,
  DEFAULT_CHATBOT_CONFIG,
  FAQ_LIMITS,
  legacyFaqItems,
  readChatbotConfig,
  readGuestRules,
} from '@/lib/booking/chatbot-config';

/**
 * The booking assistant's settings (D-078), read leniently from the booking
 * link's settings document, with the old switch and free-text FAQ standing in
 * until the new ones are saved. Fictional values only.
 */

describe('readChatbotConfig', () => {
  it('gives the defaults for an empty or unreadable document', () => {
    expect(readChatbotConfig(undefined)).toEqual(DEFAULT_CHATBOT_CONFIG);
    expect(readChatbotConfig('nonsense')).toEqual(DEFAULT_CHATBOT_CONFIG);
    expect(DEFAULT_CHATBOT_CONFIG).toEqual({
      enabled: true,
      faqItems: [],
      aiAnswers: false,
      dailyAiCap: 15,
    });
  });

  it('reads a saved chatbot field by field, one bad value never hiding the rest', () => {
    const config = readChatbotConfig({
      chatbot: {
        enabled: false,
        faqItems: [
          { q: 'Stage?', a: 'Seed.' },
          { q: '', a: 'No question' },
          { q: 'x'.repeat(FAQ_LIMITS.question + 1), a: 'Too long a question' },
          'junk',
          { q: 'Size?', a: 'Small.' },
        ],
        aiAnswers: 'yes',
        dailyAiCap: 99,
      },
      chatbotEnabled: true,
      faq: 'Ignored once chatbot is saved',
    });
    expect(config).toEqual({
      enabled: false,
      faqItems: [
        { q: 'Stage?', a: 'Seed.' },
        { q: 'Size?', a: 'Small.' },
      ],
      aiAnswers: false,
      dailyAiCap: 15,
    });
  });

  it('falls back to the old switch and the old free-text FAQ', () => {
    const config = readChatbotConfig({
      chatbotEnabled: false,
      firmName: 'Example Fund',
      faq: 'Example Fund backs software teams.\nStage: pre-seed and seed.\nCheck size: a small first check.',
    });
    expect(config.enabled).toBe(false);
    expect(config.faqItems).toEqual([
      { q: 'About Example Fund', a: 'Example Fund backs software teams.' },
      { q: 'Stage', a: 'Stage: pre-seed and seed.' },
      { q: 'Check size', a: 'Check size: a small first check.' },
    ]);
  });
});

describe('legacyFaqItems', () => {
  it('reads Q:/A: pairs when the old text was written that way', () => {
    expect(
      legacyFaqItems('Q: What stage?\nA: Seed.\nMore on seed.\nQ: Lead?\nA: Sometimes.', 'Fund'),
    ).toEqual([
      { q: 'What stage?', a: 'Seed.\nMore on seed.' },
      { q: 'Lead?', a: 'Sometimes.' },
    ]);
  });

  it('keeps links as answers, not questions, and caps the list', () => {
    expect(legacyFaqItems('https://fund.example/apply', 'Fund')).toEqual([
      { q: 'About Fund', a: 'https://fund.example/apply' },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => `Topic ${i}: answer ${i}`).join('\n');
    expect(legacyFaqItems(many, 'Fund')).toHaveLength(FAQ_LIMITS.items);
    expect(legacyFaqItems('', 'Fund')).toEqual([]);
    expect(legacyFaqItems(42, 'Fund')).toEqual([]);
  });
});

describe('saving', () => {
  it('bounds every value and cleans the text', () => {
    const ok = CHATBOT_CONFIG_SCHEMA.parse({
      enabled: true,
      faqItems: [{ q: ' Stage?\n', a: 'Seed <script>x</script>\u200b stage.\r\nNext line' }],
      aiAnswers: true,
      dailyAiCap: 30,
    });
    expect(ok.faqItems[0]).toEqual({ q: 'Stage?', a: 'Seed x stage.\nNext line' });
    expect(CHATBOT_CONFIG_SCHEMA.safeParse({ ...ok, dailyAiCap: 31 }).success).toBe(false);
    expect(CHATBOT_CONFIG_SCHEMA.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      CHATBOT_CONFIG_SCHEMA.safeParse({
        ...ok,
        faqItems: [{ q: 'q', a: 'a'.repeat(FAQ_LIMITS.answer + 1) }],
      }).success,
    ).toBe(false);
    expect(
      CHATBOT_CONFIG_SCHEMA.safeParse({
        ...ok,
        faqItems: Array.from({ length: 31 }, () => ({ q: 'q', a: 'a' })),
      }).success,
    ).toBe(false);
    expect(CHATBOT_CONFIG_PATCH.parse({ aiAnswers: true })).toEqual({ aiAnswers: true });
  });
});

describe('readGuestRules', () => {
  it('allows five guests by default and follows the link settings', () => {
    expect(readGuestRules({})).toEqual({ allowed: true, max: 5 });
    expect(readGuestRules({ allowGuests: false, maxGuests: 4 })).toEqual({
      allowed: false,
      max: 0,
    });
    expect(readGuestRules({ allowGuests: true, maxGuests: 2 })).toEqual({ allowed: true, max: 2 });
    expect(readGuestRules({ allowGuests: true, maxGuests: 0 })).toEqual({ allowed: false, max: 0 });
    expect(readGuestRules({ maxGuests: 11 })).toEqual({ allowed: true, max: 5 });
  });
});
