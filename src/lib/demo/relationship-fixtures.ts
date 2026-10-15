import { DEMO_IDS } from '@/lib/demo/ids';
import type { CalendarEvent, EmailMessage, EmailThread } from '@/lib/types/domain';

/**
 * Older mail and meetings with the people on the demo CRM lists, so their
 * profiles have a relationship to show: a strong founder relationship with an
 * upcoming check-in, an LP going quiet, a cold inbound pitch, and the person
 * who made an intro. Every name, address and subject is invented, on the same
 * `.example` domains as the CRM fixtures.
 *
 * Kept out of the inbox fixtures on purpose: it is history, read only by the
 * relationship surfaces (Network and record profiles) through
 * `loadCorrespondence`, so the Inbox, Today and every count built on the demo
 * mailbox stay exactly as they were. Times are relative to `now`, so the
 * strengths and "going cold" flags read the same on any day.
 */

const ORG = DEMO_IDS.org;
const USER = DEMO_IDS.user;
const NICK = { name: 'Nick Tippmann', email: 'nick@tiptop.demo' };

const NS = '00000000-0000-4000-8000-00005e1a';
const uuid = (n: number) => `${NS}${n.toString(16).padStart(4, '0')}`;
/** Gmail-shaped hex ids, so timeline links render as they would for real mail. */
const gmailId = (n: number) => `de0a00000000${n.toString(16).padStart(4, '0')}`;

type Who = { name: string; email: string };

const ADA = { name: 'Ada Brennan', email: 'ada@brindlehealth.example' };
const CYRUS = { name: 'Cyrus Vale', email: 'cyrus@brindlehealth.example' };
const HANA = { name: 'Hana Kuroda', email: 'hana@riverlight.example' };
const MAREN = { name: 'Maren Solberg', email: 'maren@oakhaven-capital.example' };
const DESMOND = { name: 'Desmond Achterberg', email: 'desmond@pinecrest-fo.example' };
const PRIYA = { name: 'Priya Nandakumar', email: 'priya@hearthstone-payroll.example' };
const TOMAS = { name: 'Tomas Okoye', email: 'tomas@cobaltline.example' };
const SVEN = { name: 'Sven Malmberg', email: 'sven@kestrel-analytics.example' };

/** One message: `from` wrote it to `to` (and `cc`), `day` days ago (negative is the past). */
type Step = { day: number; from: Who; to: Who[]; cc?: Who[]; text: string };

const CONVERSATIONS: { n: number; subject: string; steps: Step[] }[] = [
  {
    n: 1,
    subject: 'Intro: Brindle Health <> TipTop',
    steps: [
      {
        day: -210,
        from: HANA,
        to: [NICK],
        cc: [ADA],
        text: 'Nick, meet Ada, who is building clinical intake software I keep hearing about.',
      },
      { day: -209, from: NICK, to: [ADA], cc: [HANA], text: 'Thanks Hana. Ada, great to meet.' },
      { day: -208, from: ADA, to: [NICK], text: 'Likewise. Here are a few times next week.' },
    ],
  },
  {
    n: 2,
    subject: 'Brindle Health: Q2 metrics',
    steps: [
      { day: -120, from: ADA, to: [NICK], text: 'Quarterly numbers attached, as promised.' },
      { day: -119, from: NICK, to: [ADA], text: 'Thanks, strong quarter. Two questions inline.' },
    ],
  },
  {
    n: 3,
    subject: 'Seed extension terms',
    steps: [
      { day: -45, from: NICK, to: [ADA], text: 'Following up on the extension we discussed.' },
      { day: -44, from: ADA, to: [NICK], text: 'Draft terms below. Cyrus can walk through usage.' },
      { day: -40, from: ADA, to: [NICK], cc: [CYRUS], text: 'Looping Cyrus in for the data room.' },
    ],
  },
  {
    n: 4,
    subject: 'Hiring: head of clinical operations',
    steps: [
      { day: -12, from: ADA, to: [NICK], text: 'Any names for the clinical operations role?' },
      { day: -11, from: NICK, to: [ADA], text: 'Two people come to mind. Intros to follow.' },
    ],
  },
  {
    n: 5,
    subject: 'Customer reference for diligence',
    steps: [
      { day: -5, from: NICK, to: [ADA, CYRUS], text: 'Could we speak to one hospital customer?' },
      { day: -5, from: ADA, to: [NICK], text: 'Yes, setting it up for Thursday.' },
    ],
  },
  {
    n: 11,
    subject: 'Oakhaven: Fund II timing',
    steps: [
      { day: -260, from: MAREN, to: [NICK], text: 'When do you expect a first close on Fund II?' },
      {
        day: -259,
        from: NICK,
        to: [MAREN],
        text: 'Early next year. Happy to walk you through it.',
      },
    ],
  },
  {
    n: 12,
    subject: 'Annual meeting',
    steps: [
      { day: -150, from: NICK, to: [MAREN], text: 'Saving you a seat at the annual meeting.' },
      { day: -148, from: MAREN, to: [NICK], text: 'I will be there.' },
    ],
  },
  {
    n: 13,
    subject: 'Quarterly letter question',
    steps: [
      { day: -78, from: MAREN, to: [NICK], text: 'A question on the marks in the last letter.' },
      { day: -77, from: NICK, to: [MAREN], text: 'Good catch. The corrected table is below.' },
    ],
  },
  ...[-400, -330, -260, -190, -120, -66].map((day, i) => ({
    n: 21 + i,
    subject: ['Pinecrest allocation', 'Co-invest rights', 'Portfolio review'][i % 3] as string,
    steps:
      i % 2 === 0
        ? [
            { day, from: DESMOND, to: [NICK], text: 'Following up from our call.' },
            {
              day: day + 1,
              from: NICK,
              to: [DESMOND],
              text: 'Thanks. Notes and next steps below.',
            },
          ]
        : [
            { day, from: NICK, to: [DESMOND], text: 'Sharing the materials you asked for.' },
            { day: day + 1, from: DESMOND, to: [NICK], text: 'Received, thank you.' },
          ],
  })),
  {
    n: 31,
    subject: 'Co-invest: Lanternfish Bio',
    steps: [
      { day: -25, from: NICK, to: [HANA], text: 'Are you looking at Lanternfish this round?' },
      { day: -24, from: HANA, to: [NICK], text: 'We are. Lunch tomorrow?' },
    ],
  },
  {
    n: 41,
    subject: 'Hearthstone Payroll: board deck',
    steps: [
      { day: -60, from: PRIYA, to: [NICK], text: 'Board deck for next week attached.' },
      { day: -59, from: NICK, to: [PRIYA], text: 'Thanks. Comments on slides four and nine.' },
    ],
  },
  {
    n: 42,
    subject: 'Payroll compliance partner',
    steps: [
      { day: -20, from: NICK, to: [PRIYA], text: 'An intro to a compliance partner, if useful.' },
      { day: -19, from: PRIYA, to: [NICK], text: 'Very useful, thank you.' },
    ],
  },
  {
    n: 51,
    subject: 'Cobaltline: developer tools for regulated teams',
    steps: [
      {
        day: -200,
        from: TOMAS,
        to: [NICK],
        text: 'We are raising a seed round and would love to meet.',
      },
    ],
  },
  {
    n: 61,
    subject: 'Kestrel Analytics update',
    steps: [
      { day: -50, from: SVEN, to: [NICK], text: 'A short update on the pilot.' },
      { day: -49, from: NICK, to: [SVEN], text: 'Great progress. Let us catch up.' },
    ],
  },
  {
    n: 62,
    subject: 'Kestrel: pilot results',
    steps: [
      { day: -35, from: SVEN, to: [NICK], text: 'The pilot results are in.' },
      { day: -35, from: NICK, to: [SVEN], text: 'Congratulations. Free tomorrow?' },
    ],
  },
];

const MEETINGS: { n: number; title: string; day: number; with: Who[] }[] = [
  { n: 1, title: 'Brindle Health: first meeting', day: -200, with: [ADA] },
  { n: 2, title: 'Brindle Health: board prep', day: -90, with: [ADA, CYRUS] },
  { n: 3, title: 'Brindle Health: diligence review', day: -30, with: [ADA, CYRUS] },
  { n: 4, title: 'Brindle Health: monthly check-in', day: 6, with: [ADA] },
  { n: 11, title: 'Coffee with Maren Solberg (Oakhaven)', day: -140, with: [MAREN] },
  { n: 21, title: 'Pinecrest annual review', day: -300, with: [DESMOND] },
  { n: 22, title: 'Pinecrest: portfolio walk-through', day: -180, with: [DESMOND] },
  { n: 23, title: 'Pinecrest: allocation call', day: -70, with: [DESMOND] },
  { n: 31, title: 'Lunch with Hana Kuroda', day: -24, with: [HANA] },
  { n: 41, title: 'Hearthstone Payroll board meeting', day: -58, with: [PRIYA] },
  { n: 42, title: 'Hearthstone Payroll: hiring plan', day: -21, with: [PRIYA] },
  { n: 61, title: 'Kestrel Analytics catch-up', day: -34, with: [SVEN] },
];

export interface DemoRelationshipHistory {
  email_threads: EmailThread[];
  email_messages: EmailMessage[];
  calendar_events: CalendarEvent[];
}

export function demoRelationshipHistory(now: Date): DemoRelationshipHistory {
  /** `day` days from now, at 15:00 UTC so the hour never decides past or future. */
  const at = (day: number) => {
    const d = new Date(now.getTime() + day * 86_400_000);
    d.setUTCHours(15, 0, 0, 0);
    return d.toISOString();
  };

  const email_threads: EmailThread[] = [];
  const email_messages: EmailMessage[] = [];
  for (const c of CONVERSATIONS) {
    const threadId = uuid(c.n);
    const last = c.steps[c.steps.length - 1] as Step;
    email_threads.push({
      id: threadId,
      organization_id: ORG,
      provider: 'google',
      provider_thread_id: gmailId(c.n),
      subject: c.subject,
      last_message_at: at(last.day),
      message_count: c.steps.length,
      created_at: at(c.steps[0]?.day ?? last.day),
      updated_at: at(last.day),
    });
    c.steps.forEach((s, i) => {
      const sent = at(s.day);
      email_messages.push({
        id: uuid(0x1000 + c.n * 16 + i),
        organization_id: ORG,
        thread_id: threadId,
        provider: 'google',
        provider_message_id: `demo-rel-${c.n}-${i}`,
        subject: i === 0 ? c.subject : `Re: ${c.subject}`,
        snippet: s.text,
        from_name: s.from.name,
        from_address: s.from.email,
        to_addresses: s.to.map((w) => w.email),
        cc_addresses: (s.cc ?? []).map((w) => w.email),
        labels: [],
        is_unread: false,
        sent_at: sent,
        body_text: null,
        body_fetched_at: null,
        body_hash: null,
        has_attachments: false,
        category: 'personal_or_unrelated',
        category_confidence: null,
        category_source: null,
        importance: null,
        is_ignored: false,
        linked_deal_id: null,
        linked_portfolio_company_id: null,
        injection_flagged: false,
        created_at: sent,
        updated_at: sent,
      });
    });
  }

  const calendar_events: CalendarEvent[] = MEETINGS.map((m) => {
    const start = at(m.day);
    return {
      id: uuid(0x2000 + m.n),
      organization_id: ORG,
      user_id: USER,
      provider: 'google',
      provider_event_id: `demo-rel-event-${m.n}`,
      title: m.title,
      description: null,
      location: null,
      starts_at: start,
      ends_at: new Date(Date.parse(start) + 45 * 60_000).toISOString(),
      all_day: false,
      attendees: [
        { ...NICK, response: 'accepted' },
        ...m.with.map((w) => ({ ...w, response: 'accepted' })),
      ],
      organizer_email: NICK.email,
      is_private: false,
      created_at: start,
      updated_at: start,
    };
  });

  return { email_threads, email_messages, calendar_events };
}
