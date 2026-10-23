import { describe, expect, it } from 'vitest';
import {
  builtInEntries,
  detectIntent,
  faqEntries,
  matchFaq,
  MATCH_THRESHOLD,
  normalise,
  scoreEntry,
  stem,
  tokens,
  type PublicFacts,
} from '@/lib/booking/faq';

/**
 * The booking assistant's answers without AI (D-078): a visitor's words
 * matched locally against the written questions. Fictional firm and facts.
 */

const ITEMS = [
  { q: 'What stage do you invest in?', a: 'Pre-seed and seed software companies.' },
  { q: 'Check size', a: 'An invented $250K to $500K first check.' },
  { q: 'How do I pitch?', a: 'Share a deck link when you book; every deck is read.' },
  {
    q: 'Which sectors do you focus on?',
    a: 'Developer tools, fintech infrastructure and health software.',
  },
  { q: 'Do you lead rounds?', a: 'Sometimes; we often co-invest alongside a lead.' },
];
const ENTRIES = faqEntries(ITEMS);

const FACTS: PublicFacts = {
  hostName: 'Robin Vale',
  hostFirst: 'Robin',
  title: 'Partner, Example Fund',
  bio: 'Backs first-time founders.',
  firmName: 'Example Fund',
  offersCall: true,
  inPersonKinds: ['Coffee', 'Lunch'],
  places: ['Bean There (Old Town)'],
  allowCustomPlace: true,
  guestsAllowed: true,
  maxGuests: 3,
};

describe('normalising and stemming', () => {
  it('drops accents, case and punctuation and joins split words', () => {
    expect(normalise('Café — PRE-SEED? Co-founder, time zone!')).toBe(
      'cafe preseed cofounder timezone',
    );
    expect(normalise("How much's the check?")).toBe('amounts the check');
  });

  it('cuts words to a rough stem so forms of one word agree', () => {
    expect(stem('meetings')).toBe(stem('meeting'));
    expect(stem('investing')).toBe('invest');
    expect(stem('invested')).toBe('invest');
    expect(stem('investment')).toBe('invest');
    expect(stem('companies')).toBe('company');
    expect(stem('bus')).toBe('bus');
  });

  it('keeps only words that carry meaning, folded onto shared synonyms', () => {
    expect([...tokens('What is your check size?')]).toEqual(['size']);
    expect([...tokens('How much do you invest?')]).toEqual(['size', 'invest']);
    expect([...tokens('Can I bring my co-founder?')]).toEqual(['guest']);
    expect([...tokens('Where do you meet?')]).toEqual(['place', 'meet']);
    expect(tokens('the a of and you')).toEqual(new Set());
  });
});

describe('matching a question', () => {
  it('answers the written question a visitor means, in their own words', () => {
    const cases: [string, string][] = [
      ['what stage do you invest at', 'What stage do you invest in?'],
      ['Do you do pre-seed?', 'What stage do you invest in?'],
      ['how much do you usually invest', 'Check size'],
      ['typical cheque size?', 'Check size'],
      ['How can I send you my deck?', 'How do I pitch?'],
      ['what industries are you focused on', 'Which sectors do you focus on?'],
      ['Will you lead our round?', 'Do you lead rounds?'],
    ];
    for (const [question, expected] of cases) {
      const result = matchFaq(question, ENTRIES);
      expect(result.best?.entry.q, question).toBe(expected);
      expect(result.best!.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it('gives no answer below the threshold, and up to three near questions instead', () => {
    const result = matchFaq('Do you invest in climate hardware?', ENTRIES);
    expect(result.best).toBeNull();
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
    expect(matchFaq('tell me a joke about penguins', ENTRIES)).toEqual({
      best: null,
      suggestions: [],
    });
    expect(matchFaq('', ENTRIES)).toEqual({ best: null, suggestions: [] });
  });

  it('lists the next closest questions under an answer, best first', () => {
    const result = matchFaq('stage and check size you invest', ENTRIES);
    expect(result.best).not.toBeNull();
    const scores = result.suggestions.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(result.suggestions.map((s) => s.entry.id)).not.toContain(result.best!.entry.id);
  });

  it('scores a phrase in order higher than the same words scattered', () => {
    const entry = { q: 'Do you meet in person for coffee?', a: 'Yes.' };
    expect(scoreEntry('meet in person', entry)).toBeGreaterThan(
      scoreEntry('person, then meet', entry),
    );
  });

  it('prefers a written answer over a built-in one on a tie', () => {
    const written = faqEntries([{ q: 'Can I add guests?', a: 'Our own guest policy.' }]);
    const result = matchFaq('can I add guests', [...builtInEntries(FACTS), ...written]);
    expect(result.best?.entry.builtIn).toBeUndefined();
    expect(result.best?.entry.a).toBe('Our own guest policy.');
  });
});

describe('answers built from the public card', () => {
  it('uses only what the card and settings say', () => {
    const entries = builtInEntries(FACTS);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId['card:who']!.a).toBe(
      'Robin Vale, Partner, Example Fund. Backs first-time founders.',
    );
    expect(byId['card:kinds']!.a).toMatch(
      /30-minute video call or a 1-hour coffee or lunch in person/,
    );
    expect(byId['card:places']!.a).toBe(
      'Places to meet: Bean There (Old Town). You can also suggest a place of your own.',
    );
    expect(byId['card:guests']!.a).toMatch(/^Yes\. Add up to 3 guests/);
    expect(matchFaq('who is Robin?', entries).best?.entry.id).toBe('card:who');
    expect(matchFaq('where do we meet', entries).best?.entry.id).toBe('card:places');
    expect(matchFaq('how do I reschedule', entries).best?.entry.id).toBe('card:reschedule');
    expect(matchFaq('how long is the call', entries).best?.entry.id).toBe('card:kinds');
  });

  it('says guests cannot be added when the link does not allow them, and skips an empty card', () => {
    const entries = builtInEntries({
      ...FACTS,
      title: '',
      bio: '',
      guestsAllowed: false,
      inPersonKinds: [],
    });
    expect(entries.find((e) => e.id === 'card:who')).toBeUndefined();
    expect(entries.find((e) => e.id === 'card:places')).toBeUndefined();
    expect(entries.find((e) => e.id === 'card:guests')!.a).toMatch(/^Only you can be added/);
  });
});

describe('spotting a request to book', () => {
  it('starts the right flow from free text', () => {
    expect(detectIntent('Could we grab coffee next week?')).toEqual({
      intent: 'in_person',
      kind: 'coffee',
    });
    expect(detectIntent('lunch')).toEqual({ intent: 'in_person', kind: 'lunch' });
    expect(detectIntent('I would like to book a call')).toEqual({ intent: 'call' });
    expect(detectIntent('can we hop on a zoom')).toEqual({ intent: 'call' });
    expect(detectIntent('Can we meet in person?')).toEqual({ intent: 'in_person', kind: null });
    expect(detectIntent('I want to leave a message')).toEqual({ intent: 'message' });
    expect(detectIntent('Can I send Robin my deck?')).toEqual({ intent: 'message' });
  });

  it('leaves real questions to the answers', () => {
    expect(detectIntent('How long is a call?')).toBeNull();
    expect(detectIntent('Do you like coffee or tea more as a firm?')).toBeNull();
    expect(detectIntent('What stage do you invest in?')).toBeNull();
    expect(detectIntent('Can I bring a guest?')).toBeNull();
  });
});
