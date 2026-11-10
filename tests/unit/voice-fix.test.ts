import { describe, expect, it } from 'vitest';
import { fixTranscript, prepareNames, soundKey } from '@/lib/voice/fix';
import { ackFor, matchWake, voiceIntent } from '@/lib/voice/intent';

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
    expect(matchWake('Okay so Arwin said the wire went out')).toBeNull();
    expect(matchWake('Hi, I told Arwin about it')).toBeNull();
    expect(matchWake('That was a win for us')).toBeNull();
    expect(matchWake('Hey Erin, are you coming?')).toBeNull();
    expect(matchWake('hey Ryan')).toBeNull();
  });

  it('finds the wake anywhere, with fillers between the greeting and the name', () => {
    expect(matchWake('so yeah. Hey Arwin, open my inbox')).toEqual({ rest: 'open my inbox' });
    expect(matchWake('hey, um, Arwin')).toEqual({ rest: '' });
    expect(matchWake('hey uh um Arwin what is on today')).toEqual({ rest: 'what is on today' });
    expect(matchWake('hey uh um er Arwin')).toBeNull();
  });

  it.each([
    'Erwin',
    'Irwin',
    'Arwen',
    'Arwyn',
    'Aaron',
    'Darwin',
    'Marwin',
    'Alvin',
    'Edwin',
    'our win',
    'are win',
    'a win',
  ])('takes "hey %s" for Hey Arwin', (name) => {
    expect(matchWake(`Hey ${name}, show my tasks.`)).toEqual({ rest: 'show my tasks.' });
  });

  it('collapses repeats and keeps what came after the last one', () => {
    expect(matchWake('Hey Arwin. Hey Arwin.')).toEqual({ rest: '' });
    expect(matchWake('Hey Arwin, hey Erwin, what is due today?')).toEqual({
      rest: 'what is due today?',
    });
  });

  it('accepts "okay" and "a" as greetings only at the start of a sentence', () => {
    expect(matchWake('Okay Arwin, open notes')).toEqual({ rest: 'open notes' });
    expect(matchWake('Right. Okay Arwin, open notes')).toEqual({ rest: 'open notes' });
    expect(matchWake('it was okay Arwin said')).toBeNull();
  });
});

describe('voiceIntent ends the chat', () => {
  it.each(['bye', 'Thank you.', "that's all", 'End voice chat', 'no thanks'])('%s', (said) => {
    expect(voiceIntent(said)).toEqual({ kind: 'stop' });
  });
});

describe('ackFor', () => {
  it('answers about the question when it can tell', () => {
    expect(ackFor("What's on my calendar tomorrow?", () => 0)).toMatch(/calendar|schedule/i);
    expect(ackFor('Did Maya reply to my email?', () => 0)).toMatch(/inbox|email|mail/i);
  });

  it('never says the same line twice in a row', () => {
    const a = ackFor('Tell me something', () => 0);
    const b = ackFor('Tell me something', () => 0);
    expect(a).not.toBe(b);
    expect(b).not.toBe('On it.');
  });
});

describe('ending the voice chat', () => {
  it.each(['Ok thanks, end chat.', 'bye Arwin', "that's all for now", 'end the call'])(
    '%s ends it',
    (said) => {
      expect(voiceIntent(said)).toEqual({ kind: 'stop' });
    },
  );

  it('does not end on longer requests that mention the words', () => {
    expect(
      voiceIntent('Draft a reply saying thanks and that we are done with diligence on Acme').kind,
    ).toBe('ask');
    expect(voiceIntent('when does the chat with Maya end tomorrow').kind).toBe('ask');
  });
});
