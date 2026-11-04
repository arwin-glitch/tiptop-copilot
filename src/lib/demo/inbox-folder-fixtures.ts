import type { FullMessage, FullThread } from '@/lib/google/gmail-inbox';
import { demoAttachment } from './attachment-fixtures';
import { DEMO_USER } from './fixtures';

/**
 * Demo mode only: the mail behind the Inbox's other folders (Promotions,
 * Social, Sent, Starred, Spam, Trash) and its Drafts, so every folder has
 * something to show without a mailbox. Every name, company and address is
 * fictional and on a `.demo` domain. Times are relative to now and never
 * ahead of it. These live only in the demo Inbox; the rest of the app never
 * reads them.
 */

const NICK = `${DEMO_USER.name} <${DEMO_USER.email}>`;

export interface DemoFolderThread {
  /** A 16-hex id, the shape the Inbox's routes take. */
  id: string;
  subject: string;
  /** Gmail system labels: where it is filed, and its state. */
  labels: string[];
  messages: {
    from: string;
    to: string;
    cc?: string;
    at: string;
    text: string;
    /** A mailing list's List-Unsubscribe (and -Post) headers. */
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
    /** Fictional files (lib/demo/attachment-fixtures.ts), for the attachment preview. */
    attachments?: string[];
  }[];
}

export function demoFolderThreads(now: Date): DemoFolderThread[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return [
    {
      id: 'd0e0f00000000001',
      subject: 'Founders Summit: early-bird pricing ends Friday',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
      messages: [
        {
          from: 'Summit Team <hello@founders-summit.demo>',
          to: DEMO_USER.email,
          at: ago(7),
          text: 'Early-bird passes for the Founders Summit end this Friday. Two days of talks, office hours and a demo floor.\n\nSee you there,\nThe Summit Team',
        },
      ],
    },
    {
      id: 'd0e0f00000000002',
      subject: 'Workspace Pro: your 20% renewal discount',
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
      messages: [
        {
          from: 'Workspace Pro <offers@workspacepro.demo>',
          to: DEMO_USER.email,
          at: ago(30),
          text: 'Renew this month and keep 20% off for a year.',
          listUnsubscribe: '<mailto:optout@workspacepro.demo?subject=Remove%20me>',
          attachments: ['demo-att-renewal-quote', 'demo-att-plan-chart'],
        },
      ],
    },
    {
      id: 'd0e0f00000000003',
      subject: 'Riley Chen mentioned you in a post',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_SOCIAL'],
      messages: [
        {
          from: 'Circle Network <notify@circle-network.demo>',
          to: DEMO_USER.email,
          at: ago(11),
          text: 'Riley Chen mentioned you: "Great panel on vertical AI with Nick today."',
        },
      ],
    },
    {
      id: 'd0e0f00000000004',
      subject: 'Re: Coffee next week?',
      labels: ['SENT', 'STARRED'],
      messages: [
        {
          from: 'Morgan Pell <morgan@harborview.demo>',
          to: DEMO_USER.email,
          at: ago(52),
          text: 'Would love to catch up. Coffee next week?\n\nMorgan',
        },
        {
          from: NICK,
          to: 'Morgan Pell <morgan@harborview.demo>',
          at: ago(49),
          text: 'Tuesday 10am works. Same place as last time?\n\nNick',
        },
        {
          from: 'Morgan Pell <morgan@harborview.demo>',
          to: DEMO_USER.email,
          at: ago(47),
          text: 'Perfect, see you then.\n\nMorgan',
        },
      ],
    },
    {
      id: 'd0e0f00000000005',
      subject: 'Claim your prize now!!!',
      labels: ['SPAM', 'UNREAD'],
      messages: [
        {
          from: 'Prize Desk <winner@prize-desk.demo>',
          to: DEMO_USER.email,
          at: ago(20),
          text: 'You have been selected. Reply with your details to claim.',
        },
      ],
    },
    {
      id: 'd0e0f00000000006',
      subject: 'Lunch moved to Thursday',
      labels: ['TRASH'],
      messages: [
        {
          from: 'Casey Lin <casey@northgate.demo>',
          to: DEMO_USER.email,
          at: ago(80),
          text: 'Lunch is moved to Thursday at noon.\n\nCasey',
        },
      ],
    },
  ];
}

/** A demo folder thread in the shape the reading pane reads. */
export function demoFolderFullThread(thread: DemoFolderThread): FullThread {
  const messages: FullMessage[] = thread.messages.map((m, i) => ({
    id: `${thread.id.slice(0, 14)}${String(i).padStart(2, '0')}`,
    from: m.from,
    to: m.to,
    cc: m.cc ?? '',
    date: m.at,
    subject: i === 0 ? thread.subject : `Re: ${thread.subject}`,
    text: m.text,
    attachments: (m.attachments ?? []).flatMap((id) => {
      const file = demoAttachment(id);
      return file
        ? [
            {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: Math.floor((file.base64.length * 3) / 4),
            },
          ]
        : [];
    }),
    labelIds: thread.labels,
    ...(m.listUnsubscribe
      ? { listUnsubscribe: m.listUnsubscribe, listUnsubscribePost: m.listUnsubscribePost ?? '' }
      : {}),
  }));
  return { id: thread.id, subject: thread.subject, labelIds: thread.labels, messages };
}

export interface DemoDraft {
  draftId: string;
  threadId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  at: string;
  /** Set on a reply draft: the thread it answers. */
  replyOn: string | null;
}

/** The demo's Drafts folder to start from. */
export function demoDrafts(now: Date): DemoDraft[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return [
    {
      draftId: 'r-demo-draft-0001',
      threadId: 'd0e0d00000000001',
      to: 'Jordan Vale <jordan@brightwater.demo>',
      cc: '',
      bcc: '',
      subject: 'Intro to the Ledgerly team',
      text: 'Hi Jordan,\n\nI would love to introduce you to Maya at Ledgerly. They are raising their Series A.\n\nNick',
      html: '',
      at: ago(2),
      replyOn: null,
    },
    {
      draftId: 'r-demo-draft-0002',
      threadId: 'd0e0d00000000002',
      to: '',
      cc: '',
      bcc: '',
      subject: 'Notes for Thursday',
      text: 'Agenda:\n- Portfolio check-in\n- Fund II timeline',
      html: '',
      at: ago(26),
      replyOn: null,
    },
  ];
}
