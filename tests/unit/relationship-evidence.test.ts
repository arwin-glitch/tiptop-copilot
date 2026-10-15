import { describe, expect, it } from 'vitest';
import {
  addressesAtDomain,
  buildRelationshipIndex,
  evidenceFor,
  nameFor,
  warmThreadsFor,
} from '@/lib/network/evidence';
import { scoreRelationship } from '@/lib/network/strength';
import { buildWarmPaths, warmContext } from '@/lib/services/warm-paths';
import type { CalendarEvent, EmailMessage, EmailThread } from '@/lib/types/domain';

/**
 * The index that turns synced mail and calendar into evidence. These pin the
 * counting rules the strength score depends on — what counts for whom, what
 * is a booking rather than contact, and what is a crowd rather than a
 * relationship — on invented people at .example domains.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ME = 'nick@fund.example';
const ORG = 'org-1';

let seq = 0;
function msg(
  thread: string,
  days: number,
  from: string,
  to: string[],
  extra: Partial<EmailMessage> = {},
): EmailMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    organization_id: ORG,
    thread_id: thread,
    provider: 'google',
    provider_message_id: `p-${seq}`,
    subject: `Subject ${thread}`,
    snippet: '',
    from_name: null,
    from_address: from,
    to_addresses: to,
    cc_addresses: [],
    labels: [],
    is_unread: false,
    sent_at: ago(days),
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
    created_at: ago(days),
    updated_at: ago(days),
    ...extra,
  };
}

function event(
  id: string,
  days: number,
  attendees: CalendarEvent['attendees'],
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    organization_id: ORG,
    user_id: 'u',
    provider: 'google',
    provider_event_id: id,
    title: `Meeting ${id}`,
    description: null,
    location: null,
    starts_at: ago(days),
    ends_at: ago(days),
    all_day: false,
    attendees: [{ name: 'Nick', email: ME, response: 'accepted' }, ...attendees],
    organizer_email: ME,
    is_private: false,
    created_at: ago(days),
    updated_at: ago(days),
    ...extra,
  };
}

const threadRow = (id: string, gmail: string): EmailThread => ({
  id,
  organization_id: ORG,
  provider: 'google',
  provider_thread_id: gmail,
  subject: `Thread ${id}`,
  last_message_at: ago(0),
  message_count: 1,
  created_at: ago(0),
  updated_at: ago(0),
});

const JO = 'jo@larkspur.example';
const SAM = 'sam@larkspur.example';
const RAE = 'rae@quarry.example';

const messages: EmailMessage[] = [
  // t1: Jo writes first, Nick replies -> two-way, they started.
  msg('t1', 40, `Jo Park <${JO}>`, [ME], { from_name: 'Jo Park' }),
  msg('t1', 39, ME, [JO]),
  // t2: Nick writes to Jo and Sam; only Sam answers -> for Jo, one-way out.
  msg('t2', 10, ME, [JO, SAM]),
  msg('t2', 9, SAM, [ME], { from_name: 'Sam Ito' }),
  // t3: Rae introduces Jo (Jo on cc): counts for Rae, not for Jo.
  msg('t3', 100, RAE, [ME], { cc_addresses: [JO], from_name: 'Rae Moss' }),
  // t4: a broadcast to 20 people earns nobody anything.
  msg('t4', 5, ME, Array.from({ length: 20 }, (_, i) => `person${i}@crowd.example`).concat(JO)),
  // t5: a message dated in the future (clock skew) is not contact yet.
  msg('t5', -2, JO, [ME]),
  // A newsletter.
  msg('t6', 3, 'no-reply@larkspur.example', [ME]),
];

const events: CalendarEvent[] = [
  event('e1', 20, [{ name: 'Jo Park', email: JO, response: 'accepted' }]),
  event('e2', -6, [{ name: 'Jo Park', email: JO, response: 'accepted' }]),
  event('e3', 15, [{ name: 'Jo Park', email: JO, response: 'declined' }]),
  event('e4', 12, [{ name: 'Sam Ito', email: SAM, response: 'accepted' }], { is_private: true }),
  event('e5', 8, [
    ...Array.from({ length: 15 }, (_, i) => ({
      name: null,
      email: `guest${i}@conf.example`,
      response: 'accepted',
    })),
    { name: 'Jo Park', email: JO, response: 'accepted' },
  ]),
  event('e6', 25, [
    { name: 'Jo Park', email: JO, response: 'accepted' },
    { name: 'Sam Ito', email: SAM, response: 'accepted' },
  ]),
];

const index = buildRelationshipIndex(
  {
    messages,
    events,
    threads: [threadRow('t1', 'a1b2c3d4e5f60001')],
    ownAddresses: [ME],
  },
  NOW,
);

describe('evidence for one person', () => {
  const jo = evidenceFor(index, [JO], NOW);

  it('counts what they sent and what was sent to them, as Network does', () => {
    expect(jo.evidence).toMatchObject({
      threads: 2,
      twoWayThreads: 1,
      outboundOnlyThreads: 1,
      inboundOnlyThreads: 0,
      theyStarted: 1,
      weStarted: 1,
      emailsIn: 1,
      emailsOut: 2,
    });
  });

  it('leaves out a cc on someone else’s intro, a broadcast and a future-dated message', () => {
    expect(jo.threads.map((t) => t.key).sort()).toEqual(['t1', 't2']);
  });

  it('counts meetings held, ignores declines, crowds and bookings, and finds the next one', () => {
    expect(jo.evidence.meetingsHeld).toBe(2); // e1 and e6
    expect(jo.evidence.lastMeetingAt).toBe(ago(20));
    expect(jo.evidence.nextMeetingAt).toBe(ago(-6));
    expect(jo.meetings.find((m) => m.id === 'e2')?.upcoming).toBe(true);
  });

  it('dates first, last and last contact from the counted records', () => {
    expect(jo.evidence.firstEmailAt).toBe(ago(40));
    expect(jo.evidence.lastEmailAt).toBe(ago(10));
    expect(jo.evidence.lastContactAt).toBe(ago(10));
  });

  it('keeps private events’ attendees to themselves', () => {
    expect(evidenceFor(index, [SAM], NOW).evidence.meetingsHeld).toBe(1); // e6 only
  });

  it('carries the Gmail id for a link when the thread row was scanned', () => {
    expect(jo.threads.find((t) => t.key === 't1')?.gmailId).toBe('a1b2c3d4e5f60001');
    expect(jo.threads.find((t) => t.key === 't2')?.gmailId).toBeNull();
  });

  it('remembers names from headers and invitations', () => {
    expect(nameFor(index, JO)).toBe('Jo Park');
    expect(nameFor(index, 'unknown@nowhere.example')).toBeNull();
  });
});

describe('evidence for a company', () => {
  it('finds its people by registrable domain, never machines or personal mail', () => {
    expect(addressesAtDomain(index, 'larkspur.example')).toEqual([JO, SAM]);
    expect(addressesAtDomain(index, 'mail.larkspur.example')).toEqual([JO, SAM]);
    expect(addressesAtDomain(index, 'gmail.com')).toEqual([]);
    expect(addressesAtDomain(index, null)).toEqual([]);
  });

  it('counts a thread or meeting once, however many of its people were on it', () => {
    const company = evidenceFor(index, [JO, SAM], NOW);
    expect(company.evidence.threads).toBe(2);
    // t2 is two-way for the company: Nick wrote to both, Sam answered.
    expect(company.evidence.twoWayThreads).toBe(2);
    expect(company.evidence.meetingsHeld).toBe(2);
    expect(scoreRelationship(company.evidence, NOW).score).toBeGreaterThan(
      scoreRelationship(evidenceFor(index, [JO], NOW).evidence, NOW).score,
    );
  });
});

describe('intro paths over synced mail', () => {
  it('finds who shared a small message with the target, with warm-paths’ own rules', () => {
    const target = {
      kind: 'domain' as const,
      label: 'Larkspur',
      domains: ['larkspur.example'],
      addresses: [],
    };
    const threads = warmThreadsFor(index, { domains: target.domains }, NOW);
    // Only threads touching the company, with what has already been sent.
    expect(threads.map((t) => t.id).sort()).toEqual(['a1b2c3d4e5f60001', 't2', 't3', 't4', 't6']);
    const base = warmContext(ME);
    const built = buildWarmPaths(threads, target, {
      ownAddresses: [...base.ownAddresses, ME],
      ownDomains: base.ownDomains,
    });
    expect(built.introducers.map((p) => p.email)).toEqual([RAE]);
    expect(built.known.map((p) => p.email).sort()).toEqual([JO, SAM]);
  });
});

describe('what counts as a meeting', () => {
  const PIA = 'pia@harbourline.example';
  const ROOM = 'c_1880boardroom@resource.calendar.google.com';
  const guest = (response: string | null = 'accepted') => ({
    name: 'Pia Lund',
    email: PIA,
    response,
  });
  const calendar = buildRelationshipIndex(
    {
      messages: [],
      events: [
        event('held', 30, [guest()]),
        // Nick declined, or never answered: not a meeting he had.
        event('nick-declined', 20, [guest()], {
          attendees: [{ name: 'Nick', email: ME, response: 'declined' }, guest()],
        }),
        event('unanswered', 15, [guest()], {
          attendees: [{ name: 'Nick', email: ME, response: 'needsAction' }, guest()],
        }),
        // A hold nobody accepted is not a meeting.
        event('hold', 10, [guest('needsAction')], { title: 'Hold: Pia' }),
        // A booked room is never a person, and on its own makes no meeting.
        event('room-only', 8, [{ name: '1880 Boardroom', email: ROOM, response: 'accepted' }]),
        event('with-room', 5, [
          guest(),
          { name: '1880 Boardroom', email: ROOM, response: 'accepted' },
        ]),
      ],
      threads: [],
      ownAddresses: [ME],
    },
    NOW,
  );

  it('counts only meetings Nick went to, with the people on them', () => {
    const pia = evidenceFor(calendar, [PIA], NOW);
    expect(pia.meetings.map((m) => m.id).sort()).toEqual(['held', 'with-room']);
    expect(pia.evidence.meetingsHeld).toBe(2);
    expect(pia.evidence.lastMeetingAt).toBe(ago(5));
  });

  it('never makes a meeting room into someone Nick knows', () => {
    expect(calendar.byAddress.has(ROOM)).toBe(false);
    expect(evidenceFor(calendar, [ROOM], NOW).evidence.meetingsHeld).toBe(0);
  });
});

describe('thread direction', () => {
  it('records who wrote the newest counted message on a thread', () => {
    const jo = evidenceFor(index, [JO], NOW);
    expect(jo.threads.find((t) => t.key === 't1')?.lastFromUs).toBe(true);
    expect(evidenceFor(index, [SAM], NOW).threads.find((t) => t.key === 't2')?.lastFromUs).toBe(
      false,
    );
  });
});
