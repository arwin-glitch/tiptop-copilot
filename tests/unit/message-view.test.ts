import { describe, expect, it } from 'vitest';
import { compactLines, isLongText, longTime, splitQuoted } from '@/components/inbox/message-view';
import { sameSubject } from '@/components/followups/full-email';
import { addressOf, isFromMailbox } from '@/lib/email/addresses';

/** The pure pieces of the message view and the follow-up full email. */

describe('message view', () => {
  it('clamps only long text: past 320 characters or 6 lines', () => {
    expect(isLongText('a'.repeat(320))).toBe(false);
    expect(isLongText('a'.repeat(321))).toBe(true);
    expect(isLongText(['1', '2', '3', '4', '5', '6'].join('\n'))).toBe(false);
    expect(isLongText(['1', '2', '3', '4', '5', '6', '7'].join('\n'))).toBe(true);
  });

  it('drops the blank lines between paragraphs for a clamped preview, keeping every line of text', () => {
    expect(compactLines('Hi Priya,\n\nThanks.\n \n\n- One\n- Two')).toBe(
      'Hi Priya,\nThanks.\n- One\n- Two',
    );
  });

  it('splits the quoted reply off at "On … wrote:"', () => {
    const { main, quoted } = splitQuoted(
      'Sounds good.\n\nOn Mon, Oct 12, 2026, Rosa Vance <rosa@quillworks.demo> wrote:\n> Are you in?',
    );
    expect(main).toBe('Sounds good.');
    expect(quoted).toBe(
      'On Mon, Oct 12, 2026, Rosa Vance <rosa@quillworks.demo> wrote:\n> Are you in?',
    );
  });

  it('prints a time in the zone it is given, the same on any machine', () => {
    expect(longTime('2026-10-19T14:40:00.000Z', 'America/Chicago')).toBe('Mon, Oct 19, 9:40 AM');
    expect(longTime('2026-10-19T14:40:00.000Z', 'Asia/Tokyo')).toBe('Mon, Oct 19, 11:40 PM');
    expect(longTime('not a date', 'UTC')).toBe('');
    expect(longTime(null, 'UTC')).toBe('');
  });
});

describe('the full email', () => {
  it('reads the address out of a From header', () => {
    expect(addressOf('Rosa Vance <rosa@quillworks.demo>')).toBe('rosa@quillworks.demo');
    expect(addressOf('rosa@quillworks.demo')).toBe('rosa@quillworks.demo');
    expect(addressOf('Rosa Vance')).toBe('');
    expect(addressOf('')).toBe('');
  });

  it('takes only the exact address of the mailbox for its own, never a lookalike', () => {
    expect(isFromMailbox('Nick Tippmann <nick@tiptop.demo>', 'nick@tiptop.demo')).toBe(true);
    expect(isFromMailbox('NICK@TIPTOP.DEMO', 'nick@tiptop.demo')).toBe(true);
    expect(isFromMailbox('Nick Tippmann <nick@tiptop.demo.evil.example>', 'nick@tiptop.demo')).toBe(
      false,
    );
    // An address inside the display name is not the sender's.
    expect(isFromMailbox('"Nick <nick@tiptop.demo>" <x@evil.example>', 'nick@tiptop.demo')).toBe(
      false,
    );
    expect(isFromMailbox('"nick@tiptop.demo" <rosa@quillworks.demo>', 'nick@tiptop.demo')).toBe(
      false,
    );
    expect(isFromMailbox('Nick Tippmann <nick@tiptop.demo>', '')).toBe(false);
  });

  it('treats a subject as the same with "Re:" and case aside', () => {
    expect(sameSubject('Re: Dinner co-host tonight?', 'dinner co-host tonight?')).toBe(true);
    expect(sameSubject('RE: Fwd: Term sheet', 'Term sheet')).toBe(true);
    expect(sameSubject('Term sheet', 'Offers an intro')).toBe(false);
    expect(sameSubject('Term sheet', undefined)).toBe(false);
  });
});
