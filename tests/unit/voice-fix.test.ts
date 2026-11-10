import { describe, expect, it } from 'vitest';
import { fixTranscript, prepareNames, soundKey } from '@/lib/voice/fix';
import { matchWake, voiceIntent } from '@/lib/voice/intent';

const names = prepareNames(['Ledgerly', 'Northwind Labs', 'Maya Chen', 'Girder AI', 'Vetrix']);

describe('fixTranscript', () => {
  it('fixes the misheard "Hey Arwin, open my inbox"', () => {
    const fixed = fixTranscript('Hang on, I hope my inbox.');
    expect(fixed.changed).toBe(true);
    expect(fixed.text).toMatch(/^Hey Arwin, open my inbox\.?$/i);
    const intent = voiceIntent(fixed.text);
    expect(intent.kind).toBe('navigate');
    if (intent.kind === 'navigate') expect(intent.match.group).toBe('inbox');
  });

  it('spells the team’s names the way Kraken does', () => {
    expect(fixTranscript('find ledger lee', names).text).toBe('Find Ledgerly');
    expect(fixTranscript('pull up north wind labs', names).text).toBe('Pull up Northwind Labs');
    expect(fixTranscript('what did maya chan say', names).text).toBe('What did Maya Chen say');
  });

  it('fixes Kraken words', () => {
    expect(fixTranscript('open the in box').text).toMatch(/^Open the inbox$/i);
    expect(fixTranscript('show my follow ups').text).toMatch(/^Show my follow-ups$/i);
  });

  it('leaves ordinary sentences alone', () => {
    const plain = 'What should I tell the founder about the term sheet?';
    expect(fixTranscript(plain, names)).toEqual({ text: plain, changed: false });
    // "I hope" stays "I hope" unless a page or known name follows.
    expect(fixTranscript('I hope the round closes soon', names).text).toBe(
      'I hope the round closes soon',
    );
  });

  it('has a sound key that groups sound-alikes', () => {
    expect(soundKey('Ledgerly')).toBe(soundKey('ledgerlee'));
    expect(soundKey('Chen')).toBe(soundKey('chan'));
  });
});

describe('matchWake', () => {
  it('wakes on "Hey Arwin" and the common mishearings', () => {
    expect(matchWake('Hey Arwin.')).toEqual({ rest: '' });
    expect(matchWake('Hey Erwin, open my inbox')).toEqual({ rest: 'open my inbox' });
    expect(matchWake('hi aaron what is on today')).toEqual({ rest: 'what is on today' });
  });

  it('does not wake on talk about Arwin', () => {
    expect(matchWake('Arwin said the wire went out')).toBeNull();
    expect(matchWake('I told Erwin hey')).toBeNull();
    expect(matchWake('hang on a second')).toBeNull();
  });
});

describe('voiceIntent ends the chat', () => {
  it.each(['bye', 'Thank you.', "that's all", 'End voice chat', 'no thanks'])('%s', (said) => {
    expect(voiceIntent(said)).toEqual({ kind: 'stop' });
  });
});
