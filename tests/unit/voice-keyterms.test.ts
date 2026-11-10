import { describe, expect, it } from 'vitest';
import { keyterms } from '@/lib/voice/vocabulary';

/** The names sent to ElevenLabs to steer what it hears. Fictional names. */

describe('voice key terms', () => {
  it('keeps names ElevenLabs accepts, once each, in order', () => {
    expect(
      keyterms([
        'Follow-ups',
        'Acme Robotics',
        'acme robotics',
        'Northwind [Labs]',
        'A',
        'One two three four five six',
        'x'.repeat(51),
      ]),
    ).toEqual(['Follow-ups', 'Acme Robotics', 'Northwind Labs']);
  });

  it('stops at the cap', () => {
    const many = Array.from({ length: 1_500 }, (_, i) => `Company ${i}`);
    expect(keyterms(many)).toHaveLength(1_000);
    expect(keyterms(many, 3)).toEqual(['Company 0', 'Company 1', 'Company 2']);
  });
});

describe('the paid second listen', () => {
  it('runs only when the engine was not sure', async () => {
    const { unsure } = await import('@/lib/voice/listener');
    expect(unsure({ text: 'open inbox', confidence: 0.93 })).toBe(false);
    expect(unsure({ text: 'open in box', confidence: 0.6 })).toBe(true);
    expect(unsure({ text: 'open inbox', confidence: null })).toBe(true);
  });

  it('keeps spoken answers short', async () => {
    const { spokenText } = await import('@/lib/voice/intent');
    const long = 'This is one sentence of the answer. '.repeat(20);
    expect(spokenText(long).length).toBeLessThanOrEqual(180 + ' The rest is in the chat.'.length);
  });
});
