import { describe, expect, it } from 'vitest';
import {
  dropRepeatedLead,
  isNoiseText,
  isSilencePhrase,
  stripNoiseMarkers,
} from '@/lib/capture/text-dedupe';

/** The words two overlapping chunks share go once (D-076); noise markers never become lines. */

describe('dropping repeated words', () => {
  it('drops the run of words that ends one line and starts the next', () => {
    expect(
      dropRepeatedLead('the robot arm ships in', 'ships in March with the new gripper.'),
    ).toEqual({ text: 'March with the new gripper.', dropped: 2 });
  });

  it('ignores case and punctuation when comparing', () => {
    expect(dropRepeatedLead('We closed the round, Dana.', 'dana, thanks again.').dropped).toBe(0);
    expect(dropRepeatedLead('We closed the Round.', 'the round! It was quick.')).toEqual({
      text: 'It was quick.',
      dropped: 2,
    });
  });

  it('keeps one short repeated word: people do say "and… and"', () => {
    expect(dropRepeatedLead('so we did that and', 'and then we shipped.').dropped).toBe(0);
  });

  it('drops one long repeated word', () => {
    expect(dropRepeatedLead('we talked about manufacturing', 'manufacturing costs next.')).toEqual({
      text: 'costs next.',
      dropped: 1,
    });
  });

  it('leaves text with nothing in common alone', () => {
    expect(dropRepeatedLead('', 'Hello there.')).toEqual({ text: 'Hello there.', dropped: 0 });
    expect(dropRepeatedLead('One thing.', 'Another thing.').dropped).toBe(0);
  });
});

describe('noise', () => {
  it('strips markers and knows a line with no words', () => {
    expect(stripNoiseMarkers('[Music] Welcome back (laughs) ♪')).toBe('Welcome back');
    expect(isNoiseText('[BLANK_AUDIO]')).toBe(true);
    expect(isNoiseText(' (silence) ')).toBe(true);
    expect(isNoiseText('Okay.')).toBe(false);
  });

  it('spots Whisper’s stock phrases (dropped only when there was almost no speech)', () => {
    expect(isSilencePhrase('Thank you.')).toBe(true);
    expect(isSilencePhrase('Thanks for watching!')).toBe(true);
    expect(isSilencePhrase('Thank you, Priya.')).toBe(false);
  });
});
