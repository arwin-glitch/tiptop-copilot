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
    /** The sender's own layout (logo, signature table), shown the way Gmail shows it. */
    html?: string;
  }[];
}

/** A fictional broker's logo for the rich-email demo (a small PNG). */
const NORTHGATE_LOGO =
  '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';

/** A fictional email laid out by its sender: paragraphs, a logo, a signature table. */
const NORTHGATE_HTML = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1f1f1f"><p style="margin:0 0 8pt">Hi Nick,</p><p style="margin:0 0 8pt">Following up on our call. Attached is the renewal summary for the fund D&amp;O policy. Coverage stays at $3M with the same retention, and the premium is down 4% from last year.</p><p style="margin:0 0 8pt">If the numbers look right, I can bind it before the 30th.</p><p style="margin:0 0 12pt">Best,</p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="padding-right:12px;border-right:2px solid #17346b;vertical-align:middle"><img src="data:image/png;base64,${NORTHGATE_LOGO}" width="180" height="48" alt="Northgate Insurance"></td><td style="padding-left:12px;font-family:Arial,sans-serif;font-size:9pt;color:#444;line-height:1.4"><b style="color:#17346b;font-size:10.5pt">Dana Whitlock</b><br>Senior Account Executive<br>Northgate Insurance<br><span style="color:#17346b">(555) 010-0142</span> | <a href="https://northgate-insurance.demo" style="color:#17346b">northgate-insurance.demo</a></td></tr></table><p style="margin:12pt 0 0;font-size:7.5pt;color:#888">This message is for the named recipient only. Northgate Insurance is a fictional company in the Kraken demo.</p></div>`;

export function demoFolderThreads(now: Date): DemoFolderThread[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return [
    {
      id: 'd0e0f000000000a1',
      subject: 'Fund D&O renewal: summary attached',
      labels: ['INBOX', 'UNREAD'],
      messages: [
        {
          from: 'Dana Whitlock <dana@northgate-insurance.demo>',
          to: DEMO_USER.email,
          at: ago(1),
          text: 'Hi Nick,\n\nFollowing up on our call. Attached is the renewal summary for the fund D&O policy. Coverage stays at $3M with the same retention, and the premium is down 4% from last year.\n\nIf the numbers look right, I can bind it before the 30th.\n\nBest,\nDana Whitlock\nSenior Account Executive, Northgate Insurance',
          html: NORTHGATE_HTML,
        },
      ],
    },
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
      // In Spanish, for Translate message (Kraken AI answers the demo with canned text).
      id: 'd0e0f00000000007',
      subject: 'Invitación: encuentro de fundadores en Madrid',
      labels: ['INBOX', 'CATEGORY_SOCIAL'],
      messages: [
        {
          from: 'Lucía Romero <lucia@redfundadores.demo>',
          to: DEMO_USER.email,
          at: ago(14),
          text: 'Hola, te escribo para invitarte a nuestro encuentro de fundadores en Madrid el próximo mes. Habrá charlas, sesiones de preguntas y una cena con los equipos de la red.\n\nUn saludo,\nLucía',
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
    ...(m.html ? { html: m.html } : {}),
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
