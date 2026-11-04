import { describe, expect, it } from 'vitest';
import { eventPrefill, parsePrefill } from '@/lib/calendar/inbox-prefill';

describe('Create event from a conversation', () => {
  it('takes the subject, the people (not the mailbox) and a link back', () => {
    const p = eventPrefill({
      subject: 'Re: Fwd: Intro call',
      participants: [
        'Jane Doe <jane@founder.example>',
        'partner@firm.example',
        'JANE@founder.example',
        'not an address',
        'Sam Lee <sam@angel.example>',
      ],
      mailbox: 'partner@firm.example',
      threadUrl: 'https://app.example/inbox?thread=18c0a1b2c3d4e5f6',
    });
    expect(p).toEqual({
      title: 'Intro call',
      guests: ['jane@founder.example', 'sam@angel.example'],
      description: 'Email thread: https://app.example/inbox?thread=18c0a1b2c3d4e5f6',
    });
  });

  it('reads a fresh handoff once and refuses stale or bad ones', () => {
    const now = 1_800_000_000_000;
    const good = JSON.stringify({
      title: 'A',
      description: 'B',
      guests: ['a@x.example', 'bad'],
      at: now - 1000,
    });
    expect(parsePrefill(good, now)).toEqual({
      title: 'A',
      description: 'B',
      guests: ['a@x.example'],
    });
    const stale = JSON.stringify({
      title: 'A',
      description: 'B',
      guests: [],
      at: now - 11 * 60_000,
    });
    expect(parsePrefill(stale, now)).toBeNull();
    expect(parsePrefill('{not json', now)).toBeNull();
    expect(parsePrefill(null, now)).toBeNull();
  });
});
