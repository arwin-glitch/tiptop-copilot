import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  collectFollowUps,
  parseFollowUpMessage,
  todayLead,
  type FollowUpsResult,
  type FollowUpsSnapshot,
} from '@/lib/services/follow-ups';

/** All names and ids below are fictional. */
const post = (marker: string, value: unknown) => `${marker}\n\`${JSON.stringify(value)}\``;

const WAITING = {
  run_at: '2026-10-05T14:00:00Z',
  items: [
    {
      thread_id: '1a0000000000aaaa',
      who: 'Jane Roe',
      company: 'Zeta',
      subject: 'Data room access',
      last_sent_at: '2026-09-28T15:00:00Z',
      days_waiting: 7,
      draft: true,
    },
    {
      thread_id: '1a0000000000bbbb',
      who: 'Sam Poe',
      subject: 'Intro follow-up',
      last_sent_at: '2026-09-20T15:00:00Z',
      days_waiting: 15,
      draft: false,
      note: 'Second nudge would be the third email',
    },
  ],
};

const MEETING = {
  meeting_id: 'mtg-1',
  title: 'Acme <> TipTop',
  met_at: '2026-10-02T15:00:00Z',
  attendees: ['Ann Lee'],
  thread_id: '1a0000000000cccc',
  draft: true,
  promises: ['Send the investor shortlist'],
};

const SCHED = {
  run_at: '2026-10-05T15:00:00Z',
  items: [
    {
      thread_id: '1a0000000000dddd',
      who: 'Bo Kim',
      subject: 'Coffee next week?',
      slots: ['2026-10-13T15:00:00Z', '2026-10-14T19:00:00Z'],
      draft: true,
    },
  ],
};

const PRIORITIES = {
  run_at: '2026-10-05T11:10:00Z',
  source: 'morning',
  items: [{ title: 'Pay the Northwind invoice', why: 'Day 28 past due', kind: 'money' }],
};

describe('parseFollowUpMessage', () => {
  it('reads each marker', () => {
    expect(parseFollowUpMessage(post('FOLLOWUPS_V1', WAITING))?.marker).toBe('FOLLOWUPS_V1');
    expect(parseFollowUpMessage(post('MEETING_FOLLOWUP_V1', MEETING))?.marker).toBe(
      'MEETING_FOLLOWUP_V1',
    );
    expect(parseFollowUpMessage(post('SCHEDULING_V1', SCHED))?.marker).toBe('SCHEDULING_V1');
    expect(parseFollowUpMessage(post('PRIORITIES_V1', PRIORITIES))?.marker).toBe('PRIORITIES_V1');
  });

  it("undoes Slack's entity escaping and link markup before parsing", () => {
    const raw = post('MEETING_FOLLOWUP_V1', { ...MEETING, note: 'see URL_HERE' })
      .replace('Acme <> TipTop', 'Acme &lt;&gt; TipTop')
      .replace('URL_HERE"}', '<https://example.com/x"}>');
    const parsed = parseFollowUpMessage(raw);
    expect(parsed?.marker).toBe('MEETING_FOLLOWUP_V1');
    if (parsed?.marker === 'MEETING_FOLLOWUP_V1') {
      expect(parsed.value.title).toBe('Acme <> TipTop');
    }
  });

  it('rejects bad thread ids, unknown kinds, and other markers', () => {
    expect(
      parseFollowUpMessage(
        post('FOLLOWUPS_V1', {
          ...WAITING,
          items: [{ ...WAITING.items[0], thread_id: 'javascript:alert(1)' }],
        }),
      ),
    ).toBeNull();
    expect(
      parseFollowUpMessage(
        post('PRIORITIES_V1', { ...PRIORITIES, items: [{ ...PRIORITIES.items[0], kind: 'x' }] }),
      ),
    ).toBeNull();
    expect(parseFollowUpMessage(post('DEAL_UPSERT_V1', {}))).toBeNull();
    expect(parseFollowUpMessage('FOLLOWUPS_V1\n`not json`')).toBeNull();
    expect(parseFollowUpMessage(42)).toBeNull();
  });
});

describe('relationships', () => {
  const REL = {
    run_at: '2026-10-05T13:00:00Z',
    waiting: [
      {
        who: 'Grace Okafor',
        company: 'Lakeside',
        kind: 'prospective_lp',
        thread_id: '1a0000000000eeee',
        since: '2026-10-02T15:00:00Z',
        days: 3,
      },
    ],
    cold: [{ who: 'Ivy Chen', kind: 'lp', since: '2026-08-03T15:00:00Z', days: 63 }],
  };

  it('parses and keeps the newest radar snapshot', () => {
    expect(parseFollowUpMessage(post('RELATIONSHIPS_V1', REL))?.marker).toBe('RELATIONSHIPS_V1');
    const out = collectFollowUps([
      { ts: '1790950000.000100', text: post('RELATIONSHIPS_V1', REL), user: 'U1' },
      {
        ts: '1790900000.000100',
        text: post('RELATIONSHIPS_V1', { ...REL, waiting: [] }),
        user: 'U1',
      },
    ]);
    expect(out.relationships?.waiting).toHaveLength(1);
    expect(out.relationships?.cold[0]?.kind).toBe('lp');
  });

  it('leaves out an item with an unknown relationship kind and counts it, keeping the rest', () => {
    const parsed = parseFollowUpMessage(
      post('RELATIONSHIPS_V1', { ...REL, cold: [{ ...REL.cold[0], kind: 'friend' }] }),
    );
    expect(parsed?.marker).toBe('RELATIONSHIPS_V1');
    expect(parsed?.skipped).toBe(1);
    if (parsed?.marker !== 'RELATIONSHIPS_V1') throw new Error('expected the radar');
    expect(parsed.value.waiting).toHaveLength(1);
    expect(parsed.value.cold).toEqual([]);
    // Every item unreadable is an unreadable post: the card keeps its older copy.
    expect(
      parseFollowUpMessage(
        post('RELATIONSHIPS_V1', {
          ...REL,
          waiting: [{ ...REL.waiting[0], kind: 'friend' }],
          cold: [{ ...REL.cold[0], kind: 'friend' }],
        }),
      ),
    ).toBeNull();
  });
});

describe('LP pipeline', () => {
  const LP = {
    run_at: '2026-10-07T13:00:00Z',
    fund: 'Fund II',
    lps: [
      {
        who: 'Grace Okafor',
        firm: 'Lakeside',
        kind: 'family_office',
        stage: 'materials',
        last_touch_at: '2026-10-04T15:00:00Z',
        next_step: 'Send the deck',
        thread_id: '1a0000000000ffff',
      },
      { who: 'Sam Patel', kind: 'fund_of_funds', stage: 'target' },
    ],
  };

  it('parses the pipeline and keeps the newest snapshot', () => {
    expect(parseFollowUpMessage(post('LP_PIPELINE_V1', LP))?.marker).toBe('LP_PIPELINE_V1');
    const out = collectFollowUps([
      { ts: '1791100000.000100', text: post('LP_PIPELINE_V1', LP), user: 'U1' },
      { ts: '1791000000.000100', text: post('LP_PIPELINE_V1', { ...LP, lps: [] }), user: 'U1' },
    ]);
    expect(out.lpPipeline?.lps).toHaveLength(2);
  });

  it('rejects unknown stages and any amount field is ignored, not stored', () => {
    expect(
      parseFollowUpMessage(
        post('LP_PIPELINE_V1', { ...LP, lps: [{ ...LP.lps[0], stage: 'wired' }] }),
      ),
    ).toBeNull();
    const parsed = parseFollowUpMessage(
      post('LP_PIPELINE_V1', { ...LP, lps: [{ ...LP.lps[1], amount: 250000 }] }),
    );
    expect(parsed?.marker === 'LP_PIPELINE_V1' && 'amount' in parsed.value.lps[0]!).toBe(false);
  });
});

describe('portfolio health, intros, week ahead, LP update', () => {
  it('parses each and keeps the newest', () => {
    const health = {
      run_at: '2026-10-07T12:00:00Z',
      companies: [
        {
          name: 'Zeta',
          flag: 'watch',
          last_update_at: '2026-08-27T12:00:00Z',
          asks: ['Bridge decision'],
        },
      ],
    };
    const intros = {
      run_at: '2026-10-07T12:00:00Z',
      intros: [{ for_who: 'Zeta', to_who: 'Ivy Chen', status: 'owed' }],
    };
    const week = {
      run_at: '2026-10-07T12:00:00Z',
      events: [{ title: 'Board call', starts_at: '2026-10-08T15:00:00Z', kind: 'portfolio' }],
    };
    const lpUpdate = {
      run_at: '2026-10-05T14:00:00Z',
      period: 'Q3 2026',
      status: 'drafted',
      draft_thread_id: '1a0000000000abcd',
    };
    const out = collectFollowUps([
      { ts: '1791300000.000100', text: post('PORTFOLIO_HEALTH_V1', health), user: 'U1' },
      { ts: '1791300001.000100', text: post('INTROS_V1', intros), user: 'U1' },
      { ts: '1791300002.000100', text: post('WEEK_AHEAD_V1', week), user: 'U1' },
      { ts: '1791300003.000100', text: post('LP_UPDATE_DRAFT_V1', lpUpdate), user: 'U1' },
    ]);
    expect(out.portfolioHealth?.companies[0]?.flag).toBe('watch');
    expect(out.intros?.intros[0]?.status).toBe('owed');
    expect(out.weekAhead?.events[0]?.kind).toBe('portfolio');
    expect(out.lpUpdateDraft?.period).toBe('Q3 2026');
  });

  it('joins the numbered parts of the newest run and ignores older runs', () => {
    const run = '2026-10-07T19:00:00Z';
    const row = (n: number) => ({ for_who: `F${n}`, to_who: `T${n}`, status: 'owed' });
    const out = collectFollowUps([
      {
        ts: '1791400002.000100',
        text: post('INTROS_V1', { run_at: run, part: 2, intros: [row(2)] }),
        user: 'U1',
      },
      {
        ts: '1791400001.000100',
        text: post('INTROS_V1', { run_at: run, part: 1, intros: [row(1)] }),
        user: 'U1',
      },
      {
        ts: '1791300000.000100',
        text: post('INTROS_V1', { run_at: '2026-10-06T19:00:00Z', intros: [row(9)] }),
        user: 'U1',
      },
      {
        ts: '1791400003.000100',
        text: post('WEEK_AHEAD_V1', {
          run_at: run,
          part: 2,
          events: [{ title: 'Early', starts_at: '2026-10-08T10:00:00Z', kind: 'other' }],
        }),
        user: 'U1',
      },
      {
        ts: '1791400000.000100',
        text: post('WEEK_AHEAD_V1', {
          run_at: run,
          part: 1,
          events: [{ title: 'Late', starts_at: '2026-10-09T10:00:00Z', kind: 'other' }],
        }),
        user: 'U1',
      },
    ]);
    expect(out.intros?.intros.map((i) => i.for_who)).toEqual(['F1', 'F2']);
    expect(out.weekAhead?.events.map((e) => e.title)).toEqual(['Early', 'Late']);
  });

  it('rejects unknown flags and statuses', () => {
    expect(
      parseFollowUpMessage(
        post('PORTFOLIO_HEALTH_V1', {
          run_at: '2026-10-07T12:00:00Z',
          companies: [{ name: 'Z', flag: 'great' }],
        }),
      ),
    ).toBeNull();
    expect(
      parseFollowUpMessage(
        post('INTROS_V1', {
          run_at: '2026-10-07T12:00:00Z',
          intros: [{ for_who: 'a', to_who: 'b', status: 'maybe' }],
        }),
      ),
    ).toBeNull();
  });
});

describe('collectFollowUps', () => {
  const msg = (ts: number, text: string, user = 'U1') => ({ ts: `${ts}.000100`, text, user });

  it('keeps the newest snapshot, accumulates meetings and scheduling, sorts by wait', () => {
    const older = { ...WAITING, run_at: '2026-10-04T14:00:00Z', items: [WAITING.items[0]] };
    const out = collectFollowUps([
      msg(1790950000, post('FOLLOWUPS_V1', WAITING)),
      msg(1790940000, post('PRIORITIES_V1', PRIORITIES)),
      msg(1790930000, post('SCHEDULING_V1', SCHED)),
      msg(1790920000, post('MEETING_FOLLOWUP_V1', MEETING)),
      msg(1790910000, post('MEETING_FOLLOWUP_V1', { ...MEETING, draft: false })),
      msg(1790900000, post('FOLLOWUPS_V1', older)),
    ]);
    expect(out.waiting?.runAt).toBe(WAITING.run_at);
    expect(out.waiting?.items.map((i) => i.days_waiting)).toEqual([15, 7]);
    expect(out.meetings).toHaveLength(1);
    expect(out.meetings[0]?.draft).toBe(true);
    expect(out.scheduling).toHaveLength(1);
    expect(out.priorities?.items[0]?.kind).toBe('money');
  });

  it('honours the poster allow-list and skips subtype messages', () => {
    const out = collectFollowUps(
      [
        msg(1790950000, post('FOLLOWUPS_V1', WAITING), 'U_STRANGER'),
        { ...msg(1790940000, post('PRIORITIES_V1', PRIORITIES)), subtype: 'bot_message' },
      ],
      ['U1'],
    );
    expect(out.waiting).toBeNull();
    expect(out.priorities).toBeNull();
  });
});

describe('todayLead', () => {
  const withPriorities = (priorities: unknown) =>
    collectFollowUps(
      priorities
        ? [{ ts: '1790940000.000100', text: post('PRIORITIES_V1', priorities), user: 'U1' }]
        : [],
    );
  const result = (
    state: FollowUpsResult['state'],
    snapshot: FollowUpsSnapshot,
  ): FollowUpsResult => ({ state, snapshot, readAt: '2026-10-05T12:00:00Z' });
  const CHICAGO = 'America/Chicago';
  // 9 AM in Chicago on the list's own day; it was posted at 6:10 AM there.
  const sameDay = { now: new Date('2026-10-05T14:00:00Z'), timeZone: CHICAGO };

  it("leads Today with today's ranked list, which stands in for Do now", () => {
    const lead = todayLead(result('ok', withPriorities(PRIORITIES)), sameDay);
    expect(lead.priorities?.items.map((i) => i.title)).toEqual(['Pay the Northwind invoice']);
    expect(lead.hideNow).toBe(true);
  });

  it('still shows an older list, but leaves Do now on the page beside it', () => {
    const shown = withPriorities(PRIORITIES);
    // The next morning, before the brief, and three days on (a stopped routine).
    for (const now of ['2026-10-06T13:00:00Z', '2026-10-08T15:00:00Z']) {
      const lead = todayLead(result('ok', shown), { now: new Date(now), timeZone: CHICAGO });
      expect(lead.priorities, now).not.toBeNull();
      expect(lead.hideNow, now).toBe(false);
    }
  });

  it("judges today by the profile's own day, not UTC's", () => {
    // 10:30 PM on the 4th in Chicago, though already the 5th in UTC.
    const late = withPriorities({ ...PRIORITIES, run_at: '2026-10-05T03:30:00Z' });
    expect(todayLead(result('ok', late), sameDay).hideNow).toBe(false);
    expect(todayLead(result('ok', late), { ...sameDay, timeZone: 'UTC' }).hideNow).toBe(true);
  });

  it('is no list otherwise, so Today falls back to the glance with Do now', () => {
    const none = { priorities: null, hideNow: false };
    expect(todayLead(null, sameDay)).toEqual(none);
    expect(todayLead(result('ok', withPriorities(null)), sameDay)).toEqual(none);
    expect(todayLead(result('ok', withPriorities({ ...PRIORITIES, items: [] })), sameDay)).toEqual(
      none,
    );
    // A read that did not work hides the list, even with one in hand.
    expect(todayLead(result('not_configured', withPriorities(PRIORITIES)), sameDay)).toEqual(none);
    expect(todayLead(result('error', withPriorities(PRIORITIES)), sameDay)).toEqual(none);
  });
});

describe('lenient reading (D-073)', () => {
  /** Invented prose exactly `n` characters long, with word breaks throughout. */
  const prose = (n: number) =>
    'Walk through the pilot numbers, the two open hires and the bridge question before the call. '
      .repeat(10)
      .slice(0, n)
      .padEnd(n, 'x');
  const cut = (value: unknown, max: number) => {
    expect(typeof value).toBe('string');
    const s = value as string;
    expect(s.length).toBeLessThanOrEqual(max);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/[\s,;:.]…$/);
  };
  const RUN = '2026-10-21T11:21:01Z';

  it('cuts over-long text in every snapshot and leaves out only the bad item, counted', () => {
    const cases: Array<{ marker: string; body: Record<string, unknown>; list: string }> = [
      {
        marker: 'FOLLOWUPS_V1',
        list: 'items',
        body: {
          run_at: RUN,
          items: [
            { ...WAITING.items[0], subject: prose(330), note: prose(450) },
            { ...WAITING.items[1], days_waiting: -1 },
          ],
        },
      },
      {
        marker: 'SCHEDULING_V1',
        list: 'items',
        body: {
          run_at: RUN,
          items: [
            { ...SCHED.items[0], who: prose(150), note: prose(420) },
            { ...SCHED.items[0], thread_id: 'not-a-thread' },
          ],
        },
      },
      {
        marker: 'PRIORITIES_V1',
        list: 'items',
        body: {
          run_at: RUN,
          source: 'morning',
          items: [
            { title: prose(190), why: prose(320), kind: 'money' },
            { title: 'Sign the side letter', why: 'Due Friday', kind: 'urgent' },
          ],
        },
      },
      {
        marker: 'LP_PIPELINE_V1',
        list: 'lps',
        body: {
          run_at: RUN,
          fund: 'Fund II',
          lps: [
            { who: 'Grace Okafor', kind: 'family_office', stage: 'materials', note: prose(330) },
            { who: 'Sam Patel', kind: 'fund_of_funds', stage: 'wired' },
          ],
        },
      },
      {
        marker: 'PORTFOLIO_HEALTH_V1',
        list: 'companies',
        body: {
          run_at: RUN,
          companies: [
            { name: 'Zeta', flag: 'watch', headline: prose(260), asks: [prose(230), '  '] },
            { name: 'Quill', flag: 'great' },
          ],
        },
      },
      {
        marker: 'INTROS_V1',
        list: 'intros',
        body: {
          run_at: RUN,
          intros: [
            { for_who: 'Zeta', to_who: 'Ivy Chen', status: 'owed', note: prose(250) },
            { for_who: 'Quill', to_who: 'Bo Kim', status: 'maybe' },
          ],
        },
      },
      {
        marker: 'EMAIL_QUEUE_V1',
        list: 'items',
        body: {
          run_at: RUN,
          items: [
            {
              id: '1a0000000000abcd',
              who: 'Jane Roe',
              about: prose(230),
              group: 'money',
              call: 'reply',
              flags: ['wire', prose(40)],
              draft: 'none',
              why: prose(600),
            },
            { id: '1a0000000000abce', who: 'Sam Poe', about: 'x', group: 'later', call: 'reply' },
          ],
        },
      },
    ];
    for (const { marker, body, list } of cases) {
      const parsed = parseFollowUpMessage(post(marker, body));
      expect(parsed?.marker, marker).toBe(marker);
      expect(parsed?.skipped, marker).toBe(1);
      const kept = (parsed!.value as unknown as Record<string, unknown[]>)[list]!;
      expect(kept, marker).toHaveLength(1);
    }
    const waiting = parseFollowUpMessage(post('FOLLOWUPS_V1', cases[0]!.body));
    if (waiting?.marker !== 'FOLLOWUPS_V1') throw new Error('expected follow-ups');
    cut(waiting.value.items[0]!.subject, 300);
    cut(waiting.value.items[0]!.note, 400);
    const priorities = parseFollowUpMessage(post('PRIORITIES_V1', cases[2]!.body));
    if (priorities?.marker !== 'PRIORITIES_V1') throw new Error('expected priorities');
    cut(priorities.value.items[0]!.title, 160);
    cut(priorities.value.items[0]!.why, 300);
    const health = parseFollowUpMessage(post('PORTFOLIO_HEALTH_V1', cases[4]!.body));
    if (health?.marker !== 'PORTFOLIO_HEALTH_V1') throw new Error('expected health');
    cut(health.value.companies[0]!.headline, 200);
    expect(health.value.companies[0]!.asks).toHaveLength(1);
    cut(health.value.companies[0]!.asks[0], 200);
    const queue = parseFollowUpMessage(post('EMAIL_QUEUE_V1', cases[6]!.body));
    if (queue?.marker !== 'EMAIL_QUEUE_V1') throw new Error('expected the queue');
    cut(queue.value.items[0]!.about, 200);
    cut(queue.value.items[0]!.why, 500);
    expect(queue.value.items[0]!.flags[0]).toBe('wire');
    cut(queue.value.items[0]!.flags[1], 30);
  });

  it('reads the radar, a meeting recap and the LP update draft softly too', () => {
    const radar = parseFollowUpMessage(
      post('RELATIONSHIPS_V1', {
        run_at: RUN,
        waiting: [
          { who: prose(140), kind: 'lp', since: RUN, days: 2, note: prose(320) },
          { who: 'Ivy Chen', kind: 'lp', since: 'last week', days: 2 },
        ],
        cold: [],
      }),
    );
    if (radar?.marker !== 'RELATIONSHIPS_V1') throw new Error('expected the radar');
    expect(radar.skipped).toBe(1);
    cut(radar.value.waiting[0]!.who, 120);
    cut(radar.value.waiting[0]!.note, 300);

    const recap = parseFollowUpMessage(
      post('MEETING_FOLLOWUP_V1', {
        ...MEETING,
        title: prose(230),
        attendees: Array.from({ length: 25 }, (_, i) => `Person ${i}`),
        promises: [prose(320), ''],
        note: prose(420),
      }),
    );
    if (recap?.marker !== 'MEETING_FOLLOWUP_V1') throw new Error('expected a recap');
    expect(recap.skipped).toBe(0);
    cut(recap.value.title, 200);
    expect(recap.value.attendees).toHaveLength(20);
    expect(recap.value.promises).toHaveLength(1);
    cut(recap.value.promises[0], 300);

    const draft = parseFollowUpMessage(
      post('LP_UPDATE_DRAFT_V1', {
        run_at: RUN,
        period: `Q3 2026, ${prose(70)}`,
        status: 'drafted',
        sections: ['Portfolio', prose(90)],
        note: prose(330),
      }),
    );
    if (draft?.marker !== 'LP_UPDATE_DRAFT_V1') throw new Error('expected the draft');
    cut(draft.value.period, 60);
    cut(draft.value.sections[1], 80);
    cut(draft.value.note, 300);
  });

  it('reads no more items than a list allows, counting the rest as skipped', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `Item ${i}`,
      why: 'Ranked',
      kind: 'other',
    }));
    const parsed = parseFollowUpMessage(
      post('PRIORITIES_V1', { run_at: RUN, source: 'morning', items: many }),
    );
    if (parsed?.marker !== 'PRIORITIES_V1') throw new Error('expected priorities');
    expect(parsed.value.items.map((i) => i.title)).toEqual(many.slice(0, 7).map((i) => i.title));
    expect(parsed.skipped).toBe(2);
  });

  it('keeps ids, keys, enums and the envelope strict', () => {
    // A key is never cut: the meeting a recap is kept by, and the post with it.
    expect(
      parseFollowUpMessage(post('MEETING_FOLLOWUP_V1', { ...MEETING, meeting_id: 'm'.repeat(81) })),
    ).toBeNull();
    // A company name is matched to the portfolio: too long is that item left out.
    const health = parseFollowUpMessage(
      post('PORTFOLIO_HEALTH_V1', {
        run_at: RUN,
        companies: [
          { name: 'n'.repeat(121), flag: 'ok' },
          { name: 'Zeta', flag: 'ok' },
        ],
      }),
    );
    expect(health?.skipped).toBe(1);
    // The envelope: run_at, the source, the part number, the list itself.
    expect(
      parseFollowUpMessage(post('PRIORITIES_V1', { ...PRIORITIES, run_at: 'today' })),
    ).toBeNull();
    expect(
      parseFollowUpMessage(post('PRIORITIES_V1', { ...PRIORITIES, source: 'noon' })),
    ).toBeNull();
    expect(
      parseFollowUpMessage(post('WEEK_AHEAD_V1', { run_at: RUN, part: 99, events: [] })),
    ).toBeNull();
    expect(parseFollowUpMessage(post('WEEK_AHEAD_V1', { run_at: RUN, events: 'none' }))).toBeNull();
  });

  it("joins today's two-part week ahead: preps cut, the unknown kind left out", () => {
    const event = (day: number, kind: string, prep: string) => ({
      title: `Meeting on the ${day}th`,
      starts_at: `2026-10-${day}T15:00:00Z`,
      with_who: ['Avery Example'],
      kind,
      prep,
    });
    const yesterday = {
      run_at: '2026-10-20T11:20:00Z',
      events: [event(21, 'founder', 'Old copy')],
    };
    const part1 = {
      run_at: RUN,
      part: 1,
      events: [
        event(22, 'founder', prose(250)),
        event(22, 'lp', prose(287)),
        event(23, 'offsite', 'A kind the app does not know'),
      ],
    };
    // The same run_at, spelled with milliseconds.
    const part2 = {
      run_at: '2026-10-21T11:21:01.000Z',
      part: 2,
      events: [event(24, 'portfolio', prose(340)), event(25, 'internal', 'Short prep')],
    };
    const messages = [
      { ts: '1792588862.000200', text: post('WEEK_AHEAD_V1', part2), user: 'U1' },
      { ts: '1792588861.000100', text: post('WEEK_AHEAD_V1', part1), user: 'U1' },
      { ts: '1792502400.000100', text: post('WEEK_AHEAD_V1', yesterday), user: 'U1' },
    ];
    expect(parseFollowUpMessage(messages[1]!.text)?.skipped).toBe(1);
    expect(parseFollowUpMessage(messages[0]!.text)?.skipped).toBe(0);
    const week = collectFollowUps(messages).weekAhead;
    expect(week?.run_at).toBe(RUN);
    expect(week?.events.map((e) => e.starts_at.slice(0, 10))).toEqual([
      '2026-10-22',
      '2026-10-22',
      '2026-10-24',
      '2026-10-25',
    ]);
    for (const e of week!.events.slice(0, 3)) cut(e.prep, 240);
    expect(week?.events[3]?.prep).toBe('Short prep');
    expect(week?.events.some((e) => e.prep === 'Old copy')).toBe(false);
  });

  it('keeps names matched against records, or written into an intro email, strict', () => {
    const long =
      'Dana Example & Omar Placeholder & Priya Sample & Sam Fictional (Harbor Example Robotics Laboratories)'.padEnd(
        130,
        'x',
      );
    const intros = parseFollowUpMessage(
      post('INTROS_V1', {
        run_at: RUN,
        intros: [
          // A side too long is that intro left out, never cut into the draft.
          { for_who: long, to_who: 'Ivy Chen', status: 'owed' },
          { for_who: 'Zeta', to_who: long, status: 'owed' },
          // A firm, or a person's name, too long falls back as before.
          {
            for_who: 'Quill',
            to_who: 'Bo Kim',
            status: 'owed',
            for_org: long,
            to_people: [{ name: long }],
          },
          { for_who: 'Lumen', to_who: 'Ada Roe', status: 'made' },
        ],
      }),
    );
    if (intros?.marker !== 'INTROS_V1') throw new Error('expected intros');
    expect(intros.skipped).toBe(2);
    expect(intros.value.intros.map((i) => i.for_who)).toEqual(['Quill', 'Lumen']);
    expect(intros.value.intros[0]!.for_org).toBeNull();
    expect(intros.value.intros[0]!.to_people).toBeUndefined();

    const lps = parseFollowUpMessage(
      post('LP_PIPELINE_V1', {
        run_at: RUN,
        fund: 'Fund II',
        lps: [
          { who: long, kind: 'family_office', stage: 'materials' },
          { who: 'Grace Okafor', firm: long, kind: 'family_office', stage: 'materials' },
          { who: 'Sam Patel', firm: 'Lakeside', kind: 'fund_of_funds', stage: 'committed' },
          { who: 'Ivy Chen', kind: 'existing_lp', stage: 'committed' },
        ],
      }),
    );
    if (lps?.marker !== 'LP_PIPELINE_V1') throw new Error('expected the pipeline');
    // DocSend readers and Calendar labels match by who and firm: never cut.
    expect(lps.skipped).toBe(2);
    expect(lps.value.lps.map((l) => l.who)).toEqual(['Sam Patel', 'Ivy Chen']);
  });

  it('keeps the older copy of a one-post snapshot when most of the newer one cannot be read', () => {
    const item = (title: string, kind = 'other') => ({ title, why: 'Ranked', kind });
    const older = {
      run_at: '2026-10-21T11:00:00Z',
      source: 'morning',
      items: [item('A'), item('B'), item('C')],
    };
    // Two of three items in a kind the app does not know: refused, not shown as one.
    const newer = {
      run_at: '2026-10-21T20:00:00Z',
      source: 'afternoon',
      items: [item('D'), item('E', 'legal'), item('F', 'legal')],
    };
    expect(parseFollowUpMessage(post('PRIORITIES_V1', newer))).toBeNull();
    const snapshot = collectFollowUps([
      { ts: '1792620000.000100', text: post('PRIORITIES_V1', newer), user: 'U1' },
      { ts: '1792580000.000100', text: post('PRIORITIES_V1', older), user: 'U1' },
    ]);
    expect(snapshot.priorities?.items.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    // Half, or fewer, unreadable: the newer copy shows, less those items.
    const half = { ...newer, items: [item('D'), item('E', 'legal')] };
    expect(parseFollowUpMessage(post('PRIORITIES_V1', half))?.skipped).toBe(1);
    // Rows past the limit are not failures: nine good ones read as seven.
    const nine = { ...newer, items: Array.from({ length: 9 }, (_, i) => item(`I${i}`)) };
    expect(parseFollowUpMessage(post('PRIORITIES_V1', nine))?.skipped).toBe(2);
    // ...nor are they once the first seven include two bad ones (2 failed, 5 read).
    const nineWithBad = {
      ...newer,
      items: [
        item('D', 'legal'),
        item('E', 'legal'),
        ...Array.from({ length: 7 }, (_, i) => item(`J${i}`)),
      ],
    };
    expect(parseFollowUpMessage(post('PRIORITIES_V1', nineWithBad))?.skipped).toBe(4);

    // The radar counts both its lists, and so does follow-ups' one list.
    const radar = (bad: number, good: number) => ({
      run_at: RUN,
      waiting: Array.from({ length: bad }, () => ({ who: 'Ivy', kind: 'lp', since: 'x', days: 1 })),
      cold: Array.from({ length: good }, () => ({ who: 'Bo', kind: 'lp', since: RUN, days: 90 })),
    });
    expect(parseFollowUpMessage(post('RELATIONSHIPS_V1', radar(3, 2)))).toBeNull();
    expect(parseFollowUpMessage(post('RELATIONSHIPS_V1', radar(2, 2)))?.skipped).toBe(2);
    expect(
      parseFollowUpMessage(
        post('FOLLOWUPS_V1', {
          run_at: RUN,
          items: [WAITING.items[0], { ...WAITING.items[1], days_waiting: -1 }, { thread_id: 'zz' }],
        }),
      ),
    ).toBeNull();
  });

  it('keeps every readable row of a numbered-part snapshot, and of queues that pile up', () => {
    const event = (kind: string) => ({
      title: 'Example meeting',
      starts_at: '2026-10-22T15:00:00Z',
      kind,
    });
    // A part is not refused for most of it failing: its good rows still join the run.
    const part = parseFollowUpMessage(
      post('WEEK_AHEAD_V1', {
        run_at: RUN,
        part: 2,
        events: [event('lp'), event('offsite'), event('retreat')],
      }),
    );
    expect(part?.skipped).toBe(2);
    const queue = parseFollowUpMessage(
      post('EMAIL_QUEUE_V1', {
        run_at: RUN,
        items: [
          {
            id: '1a0000000000abcd',
            who: 'Jane Roe',
            about: 'Wire',
            group: 'money',
            call: 'reply',
            draft: 'none',
          },
          { id: 'nope', who: 'Sam Poe', about: 'x', group: 'money', call: 'reply', draft: 'none' },
          { id: 'nope2', who: 'Bo Kim', about: 'y', group: 'money', call: 'reply', draft: 'none' },
        ],
      }),
    );
    expect(queue?.skipped).toBe(2);
  });
});
