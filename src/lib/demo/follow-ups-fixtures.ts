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
