import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { collectFollowUps, parseFollowUpMessage } from '@/lib/services/follow-ups';

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

  it('rejects an unknown relationship kind', () => {
    expect(
      parseFollowUpMessage(
        post('RELATIONSHIPS_V1', { ...REL, cold: [{ ...REL.cold[0], kind: 'friend' }] }),
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
