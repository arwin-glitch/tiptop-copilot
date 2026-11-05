import { MEMBER_READ_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import { DEMO_IDS } from './ids';

/**
 * The demo teammate's own Google, connected read-only for Spaces (D-081).
 * Fictional, like every fixture: invented people at invented `.demo`
 * domains, and nothing here ever reaches Google. The demo's member-mail
 * reader (lib/services/space-member-mail.ts) serves these instead of calling
 * Gmail or Calendar.
 *
 * The mailbox holds mail about Stonebridge Ops (a Space the teammate
 * accepted, so it shows there, labelled as theirs), one thread and one
 * meeting about Ledgerly (a Space they are only invited to, so those must
 * never show) and some unrelated mail (in no Space, never shown anywhere).
 */

export const DEMO_TEAMMATE_MAILBOX = 'riley@fund.demo';

export function demoMemberIntegration(now: Date): Integration {
  const at = new Date(now.getTime() - 6 * 24 * 60 * 60_000).toISOString();
  return {
    id: DEMO_IDS.integrationTeammateSpaces,
    organization_id: DEMO_IDS.org,
    user_id: DEMO_IDS.userTeammate,
    provider: 'google_space',
    kinds: ['gmail', 'calendar'],
    account_email: DEMO_TEAMMATE_MAILBOX,
    scopes: [...MEMBER_READ_SCOPES],
    status: 'connected',
    status_detail: 'Demo connection. No real Google account is linked.',
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: null,
    created_at: at,
    updated_at: at,
  };
}

export interface DemoMemberMessage {
  from: string;
  to: string[];
  cc: string[];
  at: string;
  text: string;
}

export interface DemoMemberThread {
  /** A Gmail-shaped thread id (16 hex). */
  id: string;
  subject: string;
  messages: DemoMemberMessage[];
}

export interface DemoMemberEvent {
  id: string;
  title: string;
  startsAt: string;
  attendees: { name: string | null; email: string }[];
}

const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const daysAhead = (now: Date, d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();

export function demoMemberMailbox(now: Date): {
  threads: DemoMemberThread[];
  events: DemoMemberEvent[];
} {
  return {
    threads: [
      {
        id: 'a1b2c3d4e5f60001',
        subject: 'Stonebridge Ops: engineer shortlist for Thursday',
        messages: [
          {
            from: 'Dev Okafor <dev@stonebridgeops.demo>',
            to: [DEMO_TEAMMATE_MAILBOX],
            cc: [],
            at: hoursAgo(now, 30),
            text: 'Hi Riley, attached is the shortlist of four founding engineer candidates. Can we walk through it Thursday?',
          },
          {
            from: `Riley Moreno <${DEMO_TEAMMATE_MAILBOX}>`,
            to: ['dev@stonebridgeops.demo'],
            cc: [],
            at: hoursAgo(now, 26),
            text: 'Thanks Dev, Thursday works. I will bring notes on the two backend profiles.',
          },
        ],
      },
      {
        id: 'a1b2c3d4e5f60002',
        subject: 'Intro request: Stonebridge Ops <> logistics advisor',
        messages: [
          {
            from: 'Priya Natarajan <priya@stonebridgeops.demo>',
            to: [DEMO_TEAMMATE_MAILBOX],
            cc: ['dev@stonebridgeops.demo'],
            at: hoursAgo(now, 72),
            text: 'Riley, would you know a logistics operator who could advise us on warehouse pilots?',
          },
        ],
      },
      {
        // Ledgerly: the teammate is only invited there, so this never shows.
        id: 'a1b2c3d4e5f60003',
        subject: 'Ledgerly hiring panel availability',
        messages: [
          {
            from: 'Maya Lindqvist <maya@ledgerly.demo>',
            to: [DEMO_TEAMMATE_MAILBOX],
            cc: [],
            at: hoursAgo(now, 50),
            text: 'Riley, could you sit on the VP Sales panel next week?',
          },
        ],
      },
      {
        // In no Space at all: never shown anywhere.
        id: 'a1b2c3d4e5f60004',
        subject: 'Dentist appointment reminder',
        messages: [
          {
            from: 'Front Desk <desk@smileclinic.demo>',
            to: [DEMO_TEAMMATE_MAILBOX],
            cc: [],
            at: hoursAgo(now, 10),
            text: 'A reminder of your appointment on Friday at 9am.',
          },
        ],
      },
    ],
    events: [
      {
        id: 'demoriley0001',
        title: 'Stonebridge hiring sync',
        startsAt: hoursAgo(now, 48),
        attendees: [
          { name: 'Riley Moreno', email: DEMO_TEAMMATE_MAILBOX },
          { name: 'Dev Okafor', email: 'dev@stonebridgeops.demo' },
        ],
      },
      {
        id: 'demoriley0002',
        title: 'Stonebridge warehouse pilot review',
        startsAt: daysAhead(now, 3),
        attendees: [
          { name: 'Riley Moreno', email: DEMO_TEAMMATE_MAILBOX },
          { name: 'Priya Natarajan', email: 'priya@stonebridgeops.demo' },
        ],
      },
      {
        // Ledgerly: invited only, never shown.
        id: 'demoriley0003',
        title: 'Ledgerly VP Sales panel',
        startsAt: daysAhead(now, 5),
        attendees: [
          { name: 'Riley Moreno', email: DEMO_TEAMMATE_MAILBOX },
          { name: 'Maya Lindqvist', email: 'maya@ledgerly.demo' },
        ],
      },
      {
        id: 'demoriley0004',
        title: 'Gym',
        startsAt: hoursAgo(now, 20),
        attendees: [{ name: 'Riley Moreno', email: DEMO_TEAMMATE_MAILBOX }],
      },
    ],
  };
}
