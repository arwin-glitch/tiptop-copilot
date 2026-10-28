import type { FullMessage, FullThread } from '@/lib/google/gmail-inbox';
import { studentId } from '@/lib/portfolio/student-id';
import {
  studentWho,
  type StudentItem,
  type StudentItemInput,
  type StudentsSnapshot,
} from '@/lib/portfolio/students';
import { addDaysToKey, DEFAULT_TIMEZONE, localDateKey } from '@/lib/util/time';
import { DEMO_USER } from './fixtures';

/**
 * Demo mode only: a students routine snapshot, and the emails behind its
 * sources so the Kraken link on each opens a thread in the Inbox. Every
 * person, school, program, address and id is fictional, every address is on
 * a `.demo` domain, and times are relative to now.
 *
 * The tab's demo covers each kind and how it reads: a mentoring item whose
 * next step is on Arwin, a program with a registration deadline nine days
 * out, two intern requests (one Nick already answered, one new), and a
 * finished program behind the Done chip.
 */

const ago = (now: Date, days: number, hour = 15) => {
  const d = new Date(now.getTime() - days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * A bare day, as the routine writes a deadline: `days` after today in the
 * demo user's timezone, so the tab counts the same days at any hour.
 */
const dayIn = (now: Date, days: number) => addDaysToKey(localDateKey(now, DEFAULT_TIMEZONE), days);

export function demoStudents(now: Date): StudentsSnapshot {
  const item = (fields: Omit<StudentItemInput, 'id'>): StudentItem => ({
    ...fields,
    id: studentId(fields.kind, studentWho(fields), fields.program ?? null),
  });
  const deadline = `${dayIn(now, 9)}T12:00:00.000Z`;

  const items: StudentItem[] = [
    item({
      kind: 'mentoring',
      person: 'Tessa Marlow',
      school_or_org: 'Halden Business School',
      program: 'MBA Mentor Match',
      ask: 'A mentor for her second MBA year, aiming at early-stage venture',
      commitment: 'Two 30-min calls, one in November and one in December',
      status: 'nick_agreed',
      nick_replied: true,
      last_reply_date: ago(now, 3, 17),
      deadline: null,
      next_step: 'Book the first 30-min call with Tessa',
      next_owner: 'arwin',
      first_seen: ago(now, 12),
      last_seen: ago(now, 3, 17),
      sources: [
        {
          thread_id: '0f00000000005102',
          message_id: '0f00000000005102',
          date: ago(now, 3, 17),
          subject: 'Mentoring this fall',
        },
        {
          thread_id: '0f00000000005101',
          message_id: '0f00000000005101',
          date: ago(now, 12),
          subject: 'MBA Mentor Match: introducing Tessa Marlow',
        },
      ],
    }),
    item({
      kind: 'program',
      person: null,
      school_or_org: 'Brightwater University',
      program: 'Venture Capital Lab, spring cohort',
      ask: 'Invites TipTop to host two student analysts for the spring term',
      commitment: null,
      status: 'awaiting_nick',
      nick_replied: false,
      last_reply_date: null,
      deadline,
      next_step: 'Nick to say whether TipTop takes part before registration closes',
      next_owner: 'nick',
      first_seen: ago(now, 6),
      last_seen: ago(now, 6),
      sources: [
        {
          thread_id: '0f00000000005201',
          message_id: '0f00000000005201',
          date: ago(now, 6),
          subject: 'Invitation: Brightwater Venture Capital Lab, spring cohort',
        },
      ],
    }),
    item({
      kind: 'intern_request',
      person: 'Lena Hart',
      school_or_org: 'Brightwater University',
      program: null,
      ask: 'Asks for a 20-minute coffee chat about breaking into venture capital',
      commitment: null,
      status: 'new',
      nick_replied: false,
      last_reply_date: null,
      deadline: null,
      next_step: 'Nick to reply',
      next_owner: 'nick',
      first_seen: ago(now, 1),
      last_seen: ago(now, 1),
      sources: [
        {
          thread_id: '0f00000000005401',
          message_id: '0f00000000005401',
          date: ago(now, 1),
          subject: 'Coffee chat about VC?',
        },
      ],
    }),
    item({
      kind: 'intern_request',
      person: 'Rafael Ortiz',
      school_or_org: 'Fernmoor College',
      program: null,
      ask: 'Asks about a summer analyst internship at TipTop',
      commitment: null,
      status: 'replied',
      nick_replied: true,
      last_reply_date: ago(now, 2),
      deadline: null,
      next_step: null,
      next_owner: null,
      first_seen: ago(now, 4),
      last_seen: ago(now, 2),
      sources: [
        {
          thread_id: '0f00000000005301',
          message_id: '0f00000000005302',
          date: ago(now, 2),
          subject: 'Re: Summer analyst internship at TipTop?',
        },
      ],
    }),
    item({
      kind: 'program',
      person: null,
      school_or_org: 'Halden Business School',
      program: 'Alumni Mentor Night',
      ask: 'Asked Nick to mentor at the fall alumni mentor night',
      commitment: 'One evening on campus',
      status: 'done',
      nick_replied: true,
      last_reply_date: ago(now, 40),
      deadline: null,
      next_step: null,
      next_owner: null,
      first_seen: ago(now, 45),
      last_seen: ago(now, 13),
      sources: [
        {
          thread_id: '0f00000000005501',
          message_id: '0f00000000005501',
          date: ago(now, 13),
          subject: 'Alumni Mentor Night: thank you',
        },
      ],
    }),
  ];

  return {
    runAt: ago(now, 1, 13),
    postedAt: ago(now, 1, 13),
    scannedSince: ago(now, 5, 13),
    emailsScanned: 214,
    items,
    partial: false,
    dropped: 0,
  };
}

/* --------------------------------------------- the emails behind sources */

const NICK = `${DEMO_USER.name} <${DEMO_USER.email}>`;

interface DemoMessage {
  from: string;
  to: string;
  cc?: string;
  at: string;
  text: string;
}

function thread(id: string, subject: string, messages: DemoMessage[]): FullThread {
  const full: FullMessage[] = messages.map((m, i) => ({
    // The first message carries the thread's id, the rest count up from it.
    id: i === 0 ? id : `${id.slice(0, -1)}${(Number.parseInt(id.slice(-1), 16) + i).toString(16)}`,
    from: m.from,
    to: m.to,
    cc: m.cc ?? '',
    date: m.at,
    subject: i === 0 ? subject : `Re: ${subject}`,
    text: m.text,
    attachments: [],
    labelIds: i === messages.length - 1 && m.from !== NICK ? ['INBOX'] : [],
  }));
  return { id, subject, labelIds: [...new Set(full.flatMap((m) => m.labelIds))], messages: full };
}

function threads(now: Date): FullThread[] {
  const closes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dayIn(now, 9)}T12:00:00.000Z`));
  return [
    thread('0f00000000005101', 'MBA Mentor Match: introducing Tessa Marlow', [
      {
        from: 'Corinne Abel <mentoring@halden.demo>',
        to: NICK,
        at: ago(now, 12),
        text: [
          'Hi Nick,',
          '',
          "Thank you for joining MBA Mentor Match again this year. We've matched you with Tessa Marlow, a second-year student focused on early-stage venture.",
          '',
          'Mentors usually meet their student two or three times between November and February. Tessa will reach out directly.',
          '',
          'Warmly,',
          'Corinne Abel',
          'Career Office, Halden Business School',
        ].join('\n'),
      },
    ]),
    thread('0f00000000005102', 'Mentoring this fall', [
      {
        from: 'Tessa Marlow <tessa.marlow@halden.demo>',
        to: NICK,
        at: ago(now, 5),
        text: [
          'Hi Nick,',
          '',
          "Corinne matched us through MBA Mentor Match. I'm spending my second year on venture and would love your view on how a seed fund picks its first check.",
          '',
          'Would two 30-minute calls work, one in November and one in December?',
          '',
          'Thank you,',
          'Tessa',
        ].join('\n'),
      },
      {
        from: NICK,
        to: 'Tessa Marlow <tessa.marlow@halden.demo>',
        cc: 'EA Desk <ea@tiptop.demo>',
        at: ago(now, 3, 17),
        text: [
          'Hi Tessa,',
          '',
          "Happy to. Two 30-minute calls works. I've copied my EA, who will find times for both.",
          '',
          'Nick',
        ].join('\n'),
      },
    ]),
    thread('0f00000000005201', 'Invitation: Brightwater Venture Capital Lab, spring cohort', [
      {
        from: 'Brightwater VC Lab <vclab@brightwater.demo>',
        to: NICK,
        at: ago(now, 6),
        text: [
          'Dear Nick,',
          '',
          "Brightwater's Venture Capital Lab pairs student analysts with working funds for a semester. We would like to invite TipTop to host two analysts in the spring cohort, about four hours a week each.",
          '',
          `Fund registration closes on ${closes}.`,
          '',
          'With thanks,',
          'The VC Lab team',
        ].join('\n'),
      },
    ]),
    thread('0f00000000005301', 'Summer analyst internship at TipTop?', [
      {
        from: 'Rafael Ortiz <rortiz@fernmoor.demo>',
        to: NICK,
        at: ago(now, 4),
        text: [
          'Hi Nick,',
          '',
          "I'm a junior at Fernmoor College studying finance. Is TipTop taking a summer analyst? I'd be glad to help with market maps or diligence.",
          '',
          'Best,',
          'Rafael',
        ].join('\n'),
      },
      {
        from: NICK,
        to: 'Rafael Ortiz <rortiz@fernmoor.demo>',
        at: ago(now, 2),
        text: [
          'Hi Rafael,',
          '',
          "Thanks for reaching out. We aren't running a formal internship this summer, but keep in touch and send me what you're working on.",
          '',
          'Nick',
        ].join('\n'),
      },
    ]),
    thread('0f00000000005401', 'Coffee chat about VC?', [
      {
        from: 'Lena Hart <lena.hart@brightwater.demo>',
        to: NICK,
        at: ago(now, 1),
        text: [
          'Hi Nick,',
          '',
          "I'm a senior at Brightwater and heard you speak at the entrepreneurship club. Would you have 20 minutes for a coffee chat about breaking into venture capital?",
          '',
          'Thank you,',
          'Lena',
        ].join('\n'),
      },
    ]),
    thread('0f00000000005501', 'Alumni Mentor Night: thank you', [
      {
        from: 'Halden Alumni Office <alumni@halden.demo>',
        to: NICK,
        at: ago(now, 13),
        text: [
          'Dear Nick,',
          '',
          'Thank you for mentoring at Alumni Mentor Night. Students rated the venture table the most useful of the evening.',
          '',
          'The Alumni Office',
        ].join('\n'),
      },
    ]),
  ];
}

/** The demo email behind a students source, by thread or message id; null for any other id. */
export function demoStudentEmail(id: string, now: Date): FullThread | null {
  const key = id.toLowerCase();
  return threads(now).find((t) => t.id === key || t.messages.some((m) => m.id === key)) ?? null;
}
