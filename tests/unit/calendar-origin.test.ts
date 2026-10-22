import { describe, expect, it } from 'vitest';
import {
  checkedWords,
  distinctiveWords,
  inboxSearchFor,
  originLineText,
  originTerms,
  rankOrigins,
  siteOf,
  type OriginCandidate,
  type OriginEvent,
} from '@/lib/calendar/origin';

/**
 * "How you got here" for an event its guests say nothing about: the search
 * terms an event gives (organizer, linked sites, distinctive title words),
 * and the ranking of what a search found, best first, with nothing shown
 * below the bar. Fictional names, addresses and sites only.
 */

const OWN = ['nick@acme.example'];
const TZ = 'America/Chicago';

const mixer: OriginEvent = {
  title: 'Harborlight Founders Mixer',
  organizer: { email: 'events@harborlight-mixer.example', name: 'Harborlight Events', self: false },
  description:
    'Your ticket: https://tickets.harborlight-mixer.example/order/1234 · Join on https://meet.google.com/abc-defg-hij',
  location: 'The Lantern Room, 210 Example St',
  startsAt: '2026-10-23T23:00:00Z',
};

const email = (over: Partial<OriginCandidate>): OriginCandidate => ({
  kind: 'email',
  id: 'abcdef0123',
  title: 'Hello',
  from: null,
  fromAddress: null,
  at: '2026-10-17T15:00:00Z',
  ...over,
});

describe('the terms an event gives', () => {
  it('takes the organizer, the sites it links to and its distinctive words', () => {
    expect(originTerms(mixer, OWN)).toEqual({
      organizerEmail: 'events@harborlight-mixer.example',
      organizerDomain: 'harborlight-mixer.example',
      linkDomains: ['harborlight-mixer.example'],
      titleWords: ['Harborlight', 'Founders', 'Mixer'],
      titlePhrase: 'Harborlight Founders Mixer',
    });
  });

  it('leaves out Nick himself, free mailboxes, calendar ids and video links', () => {
    const own = originTerms(
      { ...mixer, organizer: { email: 'nick@acme.example', self: true }, description: null },
      OWN,
    );
    expect(own.organizerEmail).toBeNull();
    expect(own.organizerDomain).toBeNull();
    const free = originTerms({ ...mixer, organizer: { email: 'pat@gmail.com', self: false } }, OWN);
    expect(free.organizerEmail).toBe('pat@gmail.com');
    expect(free.organizerDomain).toBeNull();
    const group = originTerms(
      { ...mixer, organizer: { email: 'c_team@group.calendar.google.com', self: false } },
      OWN,
    );
    expect(group.organizerEmail).toBeNull();
    expect(
      originTerms({ ...mixer, description: 'https://zoom.us/j/123 https://docs.google.com/x' }, OWN)
        .linkDomains,
    ).toEqual([]);
  });

  it('drops dates, times, numbers and common words from a title', () => {
    expect(distinctiveWords('Hold: Oct 3 investor dinner @ 7pm (tentative)')).toEqual([
      'investor',
      'dinner',
    ]);
    expect(distinctiveWords('Call with Pat')).toEqual(['Pat']);
    expect(distinctiveWords('Weekly sync')).toEqual([]);
  });

  it('reads a site from a host', () => {
    expect(siteOf('tickets.harborlight-mixer.example')).toBe('harborlight-mixer.example');
    expect(siteOf('www.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('example.com')).toBe('example.com');
  });
});

describe('ranking what a search found', () => {
  const terms = originTerms(mixer, OWN);

  it('puts the ticket email from the organizer’s site first, as a registration', () => {
    const ranked = rankOrigins(
      [
        email({
          id: 'aaaaaaaaaa',
          title: 'The Weekly — this week in AI',
          from: 'Digest',
          fromAddress: 'digest@weekly.example',
        }),
        email({
          id: 'bbbbbbbbbb',
          title: 'Your ticket: Harborlight Founders Mixer',
          from: 'Harborlight Events',
          fromAddress: 'tickets@harborlight-mixer.example',
        }),
        email({
          id: 'cccccccccc',
          title: 'Re: founders dinner',
          from: 'Pat',
          fromAddress: 'pat@other.example',
        }),
      ],
      terms,
      mixer,
    );
    expect(ranked.map((r) => [r.candidate.id, r.kind])).toEqual([['bbbbbbbbbb', 'registration']]);
    expect(originLineText(ranked[0]!, TZ)).toBe(
      'Registration email from Harborlight Events, Oct 17',
    );
  });

  it('knows Google’s own invitation for it', () => {
    const ranked = rankOrigins(
      [
        email({
          id: 'dddddddddd',
          title: 'Invitation: Harborlight Founders Mixer @ Fri Oct 23',
          from: 'Pat Doe',
          fromAddress: 'pat@harborlight-mixer.example',
        }),
      ],
      terms,
      mixer,
    );
    expect(ranked[0]?.kind).toBe('invitation');
    expect(originLineText(ranked[0]!, TZ)).toBe('The invitation from Pat Doe, Oct 17');
  });

  it('marks an email sent after the event down, and shows at most three', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      email({
        id: `eeeeeeeee${i}`,
        title: `Harborlight Founders Mixer update ${i}`,
        fromAddress: 'news@harborlight-mixer.example',
      }),
    );
    expect(rankOrigins(many, terms, mixer)).toHaveLength(3);
    const after = email({
      title: 'Harborlight photos',
      fromAddress: 'photos@other.example',
      at: '2026-10-25T15:00:00Z',
    });
    expect(rankOrigins([after], terms, mixer)).toEqual([]);
  });

  it('a meeting note or an earlier event counts with nearly the same title, after the emails', () => {
    const ranked = rankOrigins(
      [
        {
          kind: 'event',
          id: 'ev1',
          title: 'Harborlight Founders Mixer',
          from: null,
          fromAddress: null,
          at: '2026-04-10T23:00:00Z',
        },
        {
          kind: 'note',
          id: 'n1',
          title: 'Harborlight Founders Mixer notes',
          from: null,
          fromAddress: null,
          at: '2026-04-11T15:00:00Z',
        },
        {
          kind: 'note',
          id: 'n2',
          title: 'Founders lunch',
          from: null,
          fromAddress: null,
          at: '2026-04-11T15:00:00Z',
        },
        email({
          id: 'ffffffffff',
          title: 'Your ticket: Harborlight Founders Mixer',
          fromAddress: 'tickets@harborlight-mixer.example',
        }),
      ],
      terms,
      mixer,
    );
    expect(ranked.map((r) => r.kind)).toEqual(['registration', 'note', 'event']);
    expect(originLineText(ranked[2]!, TZ)).toBe(
      'On the calendar before as “Harborlight Founders Mixer”, Apr 10',
    );
  });

  it('a lone title word is not enough', () => {
    const weak = email({ title: 'Mixer playlist', fromAddress: 'dj@music.example' });
    expect(
      rankOrigins(
        [weak],
        originTerms({ ...mixer, organizer: null, description: null }, OWN),
        mixer,
      ),
    ).toEqual([]);
  });
});

describe('when nothing turns up', () => {
  it('says what was checked, in plain words, and offers the Inbox search', () => {
    const terms = originTerms(mixer, OWN);
    expect(checkedWords(terms, 0)).toBe(
      'Copilot looked for a dossier note, email from harborlight-mixer.example, email mentioning harborlight-mixer.example, email about “Harborlight Founders Mixer” and a meeting note or an earlier event with this title, and found nothing that explains it.',
    );
    expect(
      checkedWords(
        originTerms({ ...mixer, organizer: null, description: null, title: 'Gym' }, OWN),
        2,
      ),
    ).toBe(
      'Copilot looked for a dossier note, emails with the guests, email about “Gym” and a meeting note or an earlier event with this title, and found nothing that explains it.',
    );
    expect(inboxSearchFor(terms, mixer.title)).toEqual({
      query: 'Harborlight Founders Mixer',
      href: '/inbox?q=Harborlight%20Founders%20Mixer',
    });
    expect(
      inboxSearchFor(originTerms({ ...mixer, title: 'Weekly sync' }, OWN), 'Weekly sync').query,
    ).toBe('Weekly sync');
  });
});
