import type { FollowUpsSnapshot } from '@/lib/services/follow-ups';

/** Demo mode only. Every name, company and id is fictional. */
export function demoFollowUps(now: Date): FollowUpsSnapshot {
  const ago = (days: number, hour = 15) => {
    const d = new Date(now.getTime() - days * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const ahead = (days: number, hour: number) => {
    const d = new Date(now.getTime() + days * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return {
    waiting: {
      runAt: ago(0, 14),
      items: [
        {
          thread_id: '0f0000000000a001',
          who: 'Priya Natarajan',
          company: 'Northwind Capital',
          subject: 'Co-invest allocation on the Zeta round',
          last_sent_at: ago(16),
          days_waiting: 16,
          draft: true,
          note: 'Second follow-up would be the third email; nudge is gentle',
        },
        {
          thread_id: '0f0000000000a002',
          who: 'Marcus Webb',
          company: 'Brightline',
          subject: 'Data room access for diligence',
          last_sent_at: ago(8),
          days_waiting: 8,
          draft: true,
        },
        {
          thread_id: '0f0000000000a003',
          who: 'Elena Ruiz',
          company: 'Girder AI',
          subject: 'Intro to our healthcare LP',
          last_sent_at: ago(4),
          days_waiting: 4,
          draft: false,
          note: 'Waiting until day 5 before drafting a nudge',
        },
      ],
    },
    meetings: [
      {
        meeting_id: 'demo-mtg-1',
        title: 'TipTop <> Harbor Labs',
        met_at: ago(1, 16),
        attendees: ['Dana Lee', 'Omar Haddad'],
        thread_id: '0f0000000000b001',
        draft: true,
        promises: ['Send the lead-investor shortlist', 'Review the memo before Tuesday'],
        posted_at: ago(1, 18),
      },
      {
        meeting_id: 'demo-mtg-2',
        title: 'Nick & Chris catch-up',
        met_at: ago(3, 20),
        attendees: ['Chris Park'],
        thread_id: null,
        draft: false,
        promises: [],
        note: 'Nick already emailed Chris after the call, so no recap was drafted',
        posted_at: ago(3, 22),
      },
    ],
    scheduling: [
      {
        thread_id: '0f0000000000c001',
        who: 'Lena Fischer',
        subject: 'Quick intro call next week?',
        slots: [ahead(8, 15), ahead(9, 19), ahead(10, 16)],
        draft: true,
        posted_at: ago(0, 15),
      },
    ],
    lpPipeline: {
      run_at: ago(0, 13),
      fund: 'Fund II',
      lps: [
        {
          who: 'Grace Okafor',
          firm: 'Lakeside Family Office',
          kind: 'family_office',
          stage: 'materials',
          last_touch_at: ago(3),
          next_step: 'Send the Fund II deck',
          thread_id: '0f0000000000f001',
          note: 'Asked for the deck after the intro call',
        },
        {
          who: 'Ivy Chen',
          firm: 'Northwind Capital',
          kind: 'existing_lp',
          stage: 'soft_commit',
          last_touch_at: ago(9),
          next_step: 'Confirm re-up timing',
          thread_id: '0f0000000000f002',
          note: null,
        },
        {
          who: 'Omar Haddad',
          firm: null,
          kind: 'individual',
          stage: 'meeting',
          last_touch_at: ago(5),
          next_step: 'Coffee booked Thursday',
          thread_id: null,
          note: null,
        },
        {
          who: 'Lena Fischer',
          firm: 'Alder Endowment',
          kind: 'institution',
          stage: 'contacted',
          last_touch_at: ago(26),
          next_step: 'Follow up on the intro',
          thread_id: '0f0000000000f003',
          note: 'No reply since the intro',
        },
        {
          who: 'Sam Patel',
          firm: 'Brightline FoF',
          kind: 'fund_of_funds',
          stage: 'target',
          last_touch_at: null,
          next_step: 'Ask Ivy for an intro',
          thread_id: null,
          note: null,
        },
        {
          who: 'Dana Lee',
          firm: null,
          kind: 'existing_lp',
          stage: 'committed',
          last_touch_at: ago(14),
          next_step: null,
          thread_id: '0f0000000000f004',
          note: 'Re-up confirmed',
        },
        {
          who: 'Chris Park',
          firm: 'Harbor Partners',
          kind: 'family_office',
          stage: 'passed',
          last_touch_at: ago(30),
          next_step: null,
          thread_id: null,
          note: 'Not adding managers this year',
        },
      ],
    },
    relationships: {
      run_at: ago(0, 13),
      waiting: [
        {
          who: 'Grace Okafor',
          company: 'Lakeside Family Office',
          kind: 'prospective_lp',
          thread_id: '0f0000000000e001',
          since: ago(3),
          days: 3,
          note: 'Asked for the Fund II deck',
        },
        {
          who: 'Tom Reyes',
          company: 'Harbor Labs',
          kind: 'portfolio',
          thread_id: '0f0000000000e002',
          since: ago(2),
          days: 2,
          note: 'Wants a quick read on a term sheet',
        },
      ],
      cold: [
        {
          who: 'Ivy Chen',
          company: 'Northwind Capital',
          kind: 'lp',
          thread_id: '0f0000000000e003',
          since: ago(63),
          days: 63,
          note: 'Used to write monthly; last exchange was the Q2 update',
        },
        {
          who: 'Sam Patel',
          company: 'Brightline',
          kind: 'coinvestor',
          thread_id: null,
          since: ago(48),
          days: 48,
          note: null,
        },
      ],
    },
    priorities: {
      run_at: ago(0, 11),
      source: 'morning',
      items: [
        {
          title: 'Pay the Northwind invoice',
          why: 'Day 28 past due, fourth notice, no receipt in the mailbox',
          kind: 'money',
          thread_id: '0f0000000000d001',
        },
        {
          title: 'Answer Harbor Labs on the shortlist',
          why: 'Promised in yesterday’s meeting; recap draft is ready in Gmail',
          kind: 'meeting',
          thread_id: '0f0000000000b001',
        },
        {
          title: 'Nudge Priya on the co-invest',
          why: '16 days with no reply; nudge drafted',
          kind: 'reply',
          thread_id: '0f0000000000a001',
        },
      ],
    },
  };
}
