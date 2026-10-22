import { describe, expect, it } from 'vitest';
import { eventColor, labelColor, NO_GOOGLE_COLOR } from '@/lib/calendar/colors';
import { colorRequest, isColorOnly, labelRequest } from '@/lib/calendar/event-actions';
import { eventLook, lookWords } from '@/lib/calendar/event-look';
import { labelsFor, suggestLabel, type LabelKnowledge } from '@/lib/calendar/label-suggest';
import {
  eventLabelKey,
  findLabel,
  labelKey,
  labelNameMatches,
  labelText,
  legendLabels,
  passesLabelFilter,
  toEventLabels,
  UNLABELLED,
} from '@/lib/calendar/labels';
import type { EventLabel, RangeEvent } from '@/lib/calendar/range-types';

/**
 * Google Calendar's colour labels and the one visual language around them
 * (D-070), as pure rules: the colour an event is drawn in, its look (past,
 * not answered, maybe, declined), the request a label sends, the suggested
 * label and when Copilot stays quiet. Fictional names and addresses only.
 */

const label = (id: string, name: string | null, background: string): EventLabel => ({
  id,
  name,
  color: { background, foreground: '#1d1d1d' },
});

const LABELS: EventLabel[] = [
  label('l-port', 'Portcos', '#33b679'),
  label('l-lps', 'LPs', '#8e24aa'),
  label('l-found', 'Founders', '#f4511e'),
  label('l-dd', 'Diligence', '#e67c73'),
  label('l-vcs', 'VCs', '#039be5'),
  label('l-int', 'Internal', '#616161'),
  label('l-trav', 'Travel', '#0b8043'),
  label('l-event', 'Event', '#f6bf26'),
];

describe('reading a calendar’s labels', () => {
  it('keeps Google’s order, each id once, names trimmed, and a grey for a bad colour', () => {
    const labels = toEventLabels({
      id: 'cal',
      labelProperties: {
        eventLabels: [
          { id: 'a', name: ' Travel ', backgroundColor: '#0B8043' },
          { id: 'b', name: '', backgroundColor: '#f6bf26' },
          { id: 'a', name: 'Again', backgroundColor: '#000000' },
          { id: 'c', name: 'Odd', backgroundColor: 'teal' },
          { id: '', name: 'No id', backgroundColor: '#123456' },
        ],
      },
    });
    expect(labels.map((l) => [l.id, l.name, l.color.background])).toEqual([
      ['a', 'Travel', '#0b8043'],
      ['b', null, '#f6bf26'],
      ['c', 'Odd', NO_GOOGLE_COLOR.background],
    ]);
    expect(labelText(labels[1])).toBe('Unnamed label');
    expect(toEventLabels(null)).toEqual([]);
    expect(toEventLabels({ id: 'cal' })).toEqual([]);
  });

  it('finds an event’s label only when its calendar defines it', () => {
    expect(findLabel(LABELS, 'l-trav')?.name).toBe('Travel');
    expect(findLabel(LABELS, 'gone')).toBeNull();
    expect(findLabel(LABELS, null)).toBeNull();
  });
});

describe('the colour an event is drawn in', () => {
  const calendar = { background: '#16a765', foreground: '#1d1d1d' };
  const colors = { event: { '11': { background: '#dc2127', foreground: '#1d1d1d' } } };

  it('is its label’s, else its own colorId’s, else its calendar’s', () => {
    const travel = findLabel(LABELS, 'l-trav');
    expect(eventColor('11', calendar, colors, travel).background).toBe('#0b8043');
    expect(eventColor('11', calendar, colors, null).background).toBe('#dc2127');
    expect(eventColor(null, calendar, colors, null)).toEqual(calendar);
    // A label the calendar no longer has is no label: the colorId still counts.
    expect(eventColor('11', calendar, colors, findLabel(LABELS, 'gone')).background).toBe(
      '#dc2127',
    );
  });

  it('gives a label readable text on its colour', () => {
    expect(labelColor('#616161')).toEqual({ background: '#616161', foreground: '#ffffff' });
    expect(labelColor('#f6bf26')).toEqual({ background: '#f6bf26', foreground: '#1d1d1d' });
    expect(labelColor('nope')).toBeNull();
  });
});

describe('a label write and a colour write', () => {
  it('a label sends eventLabelId alone, with eventLabelVersion=1, and never an email', () => {
    expect(labelRequest('l-port')).toEqual({
      body: { eventLabelId: 'l-port' },
      sendUpdates: 'none',
      eventLabelVersion: 1,
    });
    // None: Google clears a label with an empty eventLabelId.
    expect(labelRequest(null).body).toEqual({ eventLabelId: '' });
  });

  it('a colour never carries eventLabelVersion (Google would ignore the colorId)', () => {
    const request = colorRequest('11');
    expect(request).toEqual({
      body: { colorId: '11' },
      sendUpdates: 'none',
      conferenceDataVersion: 0,
    });
    expect('eventLabelVersion' in request).toBe(false);
  });

  it('a change that only relabels asks nobody', () => {
    expect(isColorOnly({ labelId: 'l-port' })).toBe(true);
    expect(isColorOnly({ labelId: null })).toBe(true);
    expect(isColorOnly({ labelId: 'l-port', title: 'x' })).toBe(false);
    expect(isColorOnly({})).toBe(false);
  });
});

describe('the legend and its filter', () => {
  const calendars = [
    { id: 'main', labels: [LABELS[0]!, LABELS[6]!] },
    {
      id: 'personal',
      labels: [label('p-trav', 'Travel', '#0b8043'), label('p-x', null, '#d50000')],
    },
    { id: 'hidden', labels: [label('h', 'Hidden', '#000000')] },
  ];

  it('lists the shown calendars’ labels once each by name', () => {
    const legend = legendLabels(calendars, ['main', 'personal']);
    expect(legend.map((l) => l.name)).toEqual(['Portcos', 'Travel', 'Unnamed label']);
    expect(legend.map((l) => l.key)).toEqual(['name:portcos', 'name:travel', 'color:#d50000']);
  });

  it('a label on two calendars filters as one; none picked shows everything', () => {
    const onMain = { label: LABELS[6]! };
    const onPersonal = { label: label('p-trav', 'Travel', '#0b8043') };
    const none = { label: null };
    expect(eventLabelKey(onMain)).toBe(eventLabelKey(onPersonal));
    expect(eventLabelKey(none)).toBe(UNLABELLED);
    const travel = [labelKey(LABELS[6]!)];
    expect([onMain, onPersonal, none].map((e) => passesLabelFilter(e, travel))).toEqual([
      true,
      true,
      false,
    ]);
    expect(passesLabelFilter(none, [UNLABELLED])).toBe(true);
    expect(passesLabelFilter(none, [])).toBe(true);
  });

  it('matches a label by the name someone asked for', () => {
    expect(labelNameMatches('Portcos', 'portcos')).toBe(true);
    expect(labelNameMatches('Portcos', 'Portco')).toBe(true);
    expect(labelNameMatches('Portcos', 'Portcos meetings')).toBe(true);
    expect(labelNameMatches('Board Work', 'board work')).toBe(true);
    expect(labelNameMatches('LPs', 'LP')).toBe(true);
    // Part of a longer name, either way round.
    expect(labelNameMatches('Board Work', 'board')).toBe(true);
    expect(labelNameMatches('Board Work', 'board travel')).toBe(false);
    expect(labelNameMatches('Travel', 'Portcos')).toBe(false);
    expect(labelNameMatches(null, 'Travel')).toBe(false);
  });
});

describe('how an event looks', () => {
  const now = Date.parse('2026-10-21T15:00:00Z');
  const base = {
    allDay: false,
    startsAt: '2026-10-21T13:00:00Z',
    endsAt: '2026-10-21T14:00:00Z',
    endDate: null,
    myResponse: 'accepted' as string | null,
    organizer: { email: 'pat@other.example', name: null, self: false },
  };

  it('is faded once it ended, in every view, never before the page has a clock', () => {
    expect(eventLook(base, { nowMs: now, today: '2026-10-21' }).past).toBe(true);
    expect(
      eventLook({ ...base, endsAt: '2026-10-21T16:00:00Z' }, { nowMs: now, today: '2026-10-21' })
        .past,
    ).toBe(false);
    expect(eventLook(base, { nowMs: null, today: '2026-10-21' }).past).toBe(false);
    // An all-day event is over once today reaches its (exclusive) end.
    const allDay = { ...base, allDay: true, startsAt: null, endsAt: null };
    expect(
      eventLook({ ...allDay, endDate: '2026-10-21' }, { nowMs: now, today: '2026-10-21' }).past,
    ).toBe(true);
    expect(
      eventLook({ ...allDay, endDate: '2026-10-22' }, { nowMs: now, today: '2026-10-21' }).past,
    ).toBe(false);
  });

  it('shows Nick’s own answer: not answered, maybe, declined; accepted looks plain', () => {
    const at = { nowMs: null, today: '2026-10-21' };
    expect(eventLook({ ...base, myResponse: 'needsAction' }, at).response).toBe('needsAction');
    expect(eventLook({ ...base, myResponse: 'tentative' }, at).response).toBe('tentative');
    expect(eventLook({ ...base, myResponse: 'declined' }, at).response).toBe('declined');
    expect(eventLook({ ...base, myResponse: 'accepted' }, at).response).toBeNull();
    expect(eventLook({ ...base, myResponse: null }, at).response).toBeNull();
    // The organizer has nothing to answer.
    expect(
      eventLook(
        { ...base, myResponse: 'needsAction', organizer: { ...base.organizer, self: true } },
        at,
      ).response,
    ).toBeNull();
  });

  it('says it in the card’s words, the answer first', () => {
    expect(lookWords({ past: true, response: 'declined' })).toEqual(['Declined', 'Ended']);
    expect(lookWords({ past: false, response: 'needsAction' })).toEqual(['Not answered yet']);
    expect(lookWords({ past: false, response: 'tentative' })).toEqual(['Maybe']);
    expect(lookWords({ past: false, response: null })).toEqual([]);
  });
});

/* ---------------------------------------------------- suggested labels */

const OWN = ['nick@acme.example'];

const KNOWLEDGE: LabelKnowledge = {
  ownDomains: ['acme.example'],
  portfolioEmails: new Map([['maya@ledger.example', 'Ledger Co']]),
  portfolioDomains: new Map([['ledger.example', 'Ledger Co']]),
  dealEmails: new Map([['tom@girder.example', { name: 'Girder', stage: 'diligence' }]]),
  dealDomains: new Map([
    ['girder.example', { name: 'Girder', stage: 'diligence' }],
    ['vetro.example', { name: 'Vetro', stage: 'new' }],
  ]),
  lpEmails: new Set(['elena@marchfield.example']),
  lpNames: new Set(['lena fischer']),
  lpFirms: new Set(['alderendowment']),
  vcEmails: new Map([['dan@ridgeway.example', 'Ridgeway Capital']]),
  vcDomains: new Map([['ridgeway.example', 'Ridgeway Capital']]),
};

function event(over: Partial<RangeEvent> = {}): RangeEvent {
  return {
    key: 'cal␟e1',
    id: 'e1',
    calendarId: 'cal',
    recurringEventId: null,
    title: 'Catch-up',
    allDay: false,
    startsAt: '2026-10-22T15:00:00Z',
    endsAt: '2026-10-22T16:00:00Z',
    startDate: null,
    endDate: null,
    timeZone: null,
    location: null,
    place: null,
    description: null,
    joinUrl: null,
    meetUrl: null,
    meetPending: false,
    colorId: null,
    labelId: null,
    label: null,
    color: { background: '#16a765', foreground: '#1d1d1d' },
    organizer: { email: 'nick@acme.example', name: null, self: true },
    attendees: [],
    guestsCanModify: false,
    canModify: true,
    readOnlyReason: null,
    canRespond: false,
    myResponse: null,
    attachments: [],
    verdict: { meeting: true, reason: 'With someone', with: [] },
    hold: false,
    inPerson: false,
    transparent: false,
    eventType: 'default',
    htmlLink: null,
    ...over,
  };
}

const guest = (email: string, name: string | null = null) => ({
  email,
  name,
  response: 'accepted',
  self: false,
  resource: false,
  organizer: false,
  optional: false,
});

const me = {
  email: 'nick@acme.example',
  name: 'Nick',
  response: 'accepted',
  self: true,
  resource: false,
  organizer: true,
  optional: false,
};

const suggest = (e: RangeEvent, labels = LABELS) => suggestLabel(e, labels, KNOWLEDGE, OWN);

describe('the suggested label', () => {
  it('a portfolio founder: the portfolio label, with why', () => {
    const s = suggest(event({ attendees: [me, guest('maya@ledger.example', 'Maya Chen')] }));
    expect(s).toEqual({
      labelId: 'l-port',
      name: 'Portcos',
      reason: 'Maya Chen is at Ledger Co, a portfolio company.',
    });
  });

  it('a deal founder: Diligence when the deal is in diligence, Founders otherwise', () => {
    expect(suggest(event({ attendees: [me, guest('tom@girder.example')] }))?.name).toBe(
      'Diligence',
    );
    expect(suggest(event({ attendees: [me, guest('ana@vetro.example')] }))?.name).toBe('Founders');
    // No Diligence label: a diligence-stage founder still gets Founders.
    expect(
      suggest(
        event({ attendees: [me, guest('tom@girder.example')] }),
        LABELS.filter((l) => l.id !== 'l-dd'),
      )?.name,
    ).toBe('Founders');
  });

  it('an LP or Fund II prospect: by address, by name, or by firm', () => {
    expect(suggest(event({ attendees: [me, guest('elena@marchfield.example')] }))?.name).toBe(
      'LPs',
    );
    expect(
      suggest(event({ attendees: [me, guest('l.f@somewhere.example', 'Lena Fischer')] }))?.name,
    ).toBe('LPs');
    expect(suggest(event({ attendees: [me, guest('lena@alder-endowment.example')] }))?.name).toBe(
      'LPs',
    );
  });

  it('another VC firm: the VC label', () => {
    expect(suggest(event({ attendees: [me, guest('dan@ridgeway.example')] }))?.name).toBe('VCs');
  });

  it('only the team: Internal; with an outsider nobody knows, nothing', () => {
    expect(suggest(event({ attendees: [me, guest('jo@acme.example')] }))?.name).toBe('Internal');
    expect(
      suggest(event({ attendees: [me, guest('jo@acme.example'), guest('x@stranger.example')] })),
    ).toBeNull();
  });

  it('a booking or a flight: Travel; a registration: Event', () => {
    expect(
      suggest(
        event({
          verdict: {
            meeting: false,
            reason: 'Booking from Gmail (flight, hotel, reservation)',
            with: [],
          },
          eventType: 'fromGmail',
        }),
      )?.name,
    ).toBe('Travel');
    expect(
      suggest(
        event({
          title: 'Flight to Denver',
          verdict: { meeting: false, reason: 'A block on the calendar', with: [] },
        }),
      )?.name,
    ).toBe('Travel');
    expect(
      suggest(
        event({
          title: 'Founders mixer',
          organizer: { email: 'events@mixer.example', name: 'Mixer', self: false },
          verdict: { meeting: false, reason: 'An event registration, not a meeting', with: [] },
        }),
      )?.name,
    ).toBe('Event');
  });

  it('with people of several kinds, the first kind decides: portfolio, deal, LP, then VC', () => {
    // A board meeting: the founder and another VC on the board.
    expect(
      suggest(
        event({ attendees: [me, guest('dan@ridgeway.example'), guest('maya@ledger.example')] }),
      )?.name,
    ).toBe('Portcos');
    expect(
      suggest(
        event({ attendees: [me, guest('elena@marchfield.example'), guest('ana@vetro.example')] }),
      )?.name,
    ).toBe('Founders');
    expect(
      suggest(
        event({
          attendees: [me, guest('dan@ridgeway.example'), guest('elena@marchfield.example')],
        }),
      )?.name,
    ).toBe('LPs');
  });

  it('stays quiet when unsure: already labelled, no labels, no clear sign, or two labels fit', () => {
    const port = event({ attendees: [me, guest('maya@ledger.example')] });
    expect(suggest({ ...port, labelId: 'l-lps' })).toBeNull();
    expect(suggest(port, [])).toBeNull();
    expect(suggest(event({ attendees: [me, guest('x@stranger.example')] }))).toBeNull();
    expect(suggest(event({ attendees: [] }))).toBeNull();
    const twoPortfolio = [...LABELS, label('l-port2', 'Portfolio', '#000000')];
    expect(suggest(port, twoPortfolio)).toBeNull();
    // No label's name fits: nothing, rather than a guess.
    expect(suggest(port, [label('x', 'Board Work', '#123456')])).toBeNull();
  });

  it('reads a label’s name by whole words, and keeps investor relations off the VC label', () => {
    const names = (category: Parameters<typeof labelsFor>[0], list: EventLabel[]) =>
      labelsFor(category, list).map((l) => l.name);
    const list = [
      label('1', 'Investor relations', '#000000'),
      label('2', 'Co-investors', '#000000'),
      label('3', 'Portfolio cos', '#000000'),
      label('4', 'Events', '#000000'),
      label('5', 'Teamwork', '#000000'),
    ];
    expect(names('lp', list)).toEqual(['Investor relations']);
    expect(names('vc', list)).toEqual(['Co-investors']);
    expect(names('portfolio', list)).toEqual(['Portfolio cos']);
    expect(names('event', list)).toEqual(['Events']);
    expect(names('internal', list)).toEqual([]);
  });
});
