import { describe, expect, it } from 'vitest';
import {
  cadenceDays,
  cadenceLabel,
  cadenceStatus,
  checkInTitle,
  choiceForDays,
  dueLabel,
  dueSoonDays,
  lastCheckInAt,
  planCheckIns,
  recordPath,
  type CheckInCandidate,
  type TaskLike,
} from '@/lib/crm/cadence';
import { contactEvidenceFrom } from '@/lib/crm/contact-evidence';
import { buildRelationshipIndex, evidenceFor } from '@/lib/network/evidence';
import type { CalendarEvent, EmailMessage } from '@/lib/types/domain';

/**
 * Keep-in-touch arithmetic and the check-in task rules, without a store.
 * Every name and address is invented.
 */

const NOW = new Date('2026-10-15T15:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const RECORD = '0b7c4a52-5f0e-4c39-9d7e-3f1a2b6c8d90';
const OTHER = '6f2d9e14-1a3b-4c5d-8e7f-90a1b2c3d4e5';

describe('cadences', () => {
  it('turns a choice into days, and refuses a custom number out of range', () => {
    expect(cadenceDays('biweekly')).toBe(14);
    expect(cadenceDays('monthly')).toBe(30);
    expect(cadenceDays('quarterly')).toBe(91);
    expect(cadenceDays('custom', 10)).toBe(10);
    expect(cadenceDays('custom', 0)).toBeNull();
    expect(cadenceDays('custom', 366)).toBeNull();
    expect(cadenceDays('custom', 2.5)).toBeNull();
    expect(cadenceDays('custom', null)).toBeNull();
  });

  it('names a cadence the way the picker does', () => {
    expect(cadenceLabel(14)).toBe('Every 2 weeks');
    expect(cadenceLabel(30)).toBe('Every month');
    expect(cadenceLabel(91)).toBe('Every quarter');
    expect(cadenceLabel(10)).toBe('Every 10 days');
    expect(cadenceLabel(1)).toBe('Every day');
    expect(choiceForDays(30)).toBe('monthly');
    expect(choiceForDays(45)).toBe('custom');
  });

  it('counts from the last contact', () => {
    const status = cadenceStatus({
      cadence: { days: 30, setAt: ago(2) },
      lastContactAt: ago(10),
      lastCheckInAt: null,
      now: NOW,
    });
    expect(status.basis).toBe('contact');
    expect(status.anchorAt).toBe(ago(10));
    expect(status.dueAt).toBe(ahead(20));
    expect(status.daysUntilDue).toBe(20);
    expect(status.state).toBe('on_track');
    expect(dueLabel(status)).toBe('Due in 20 days');
  });

  it('counts from a check-in finished after the last contact', () => {
    const status = cadenceStatus({
      cadence: { days: 14, setAt: ago(100) },
      lastContactAt: ago(40),
      lastCheckInAt: ago(3),
      now: NOW,
    });
    expect(status.basis).toBe('check_in');
    expect(status.dueAt).toBe(ahead(11));
  });

  it('counts from when it was set when there is no contact on record', () => {
    const status = cadenceStatus({
      cadence: { days: 30, setAt: ago(0) },
      lastContactAt: null,
      lastCheckInAt: null,
      now: NOW,
    });
    expect(status.basis).toBe('set');
    expect(status.state).toBe('on_track');
    expect(status.daysUntilDue).toBe(30);
  });

  it('is due soon inside a week (less for short cadences), and overdue once past', () => {
    expect(dueSoonDays(30)).toBe(7);
    expect(dueSoonDays(14)).toBe(4);
    expect(dueSoonDays(2)).toBe(1);
    const soon = cadenceStatus({
      cadence: { days: 30, setAt: ago(60) },
      lastContactAt: ago(25),
      lastCheckInAt: null,
      now: NOW,
    });
    expect(soon.state).toBe('due_soon');
    expect(dueLabel(soon)).toBe('Due in 5 days');
    const late = cadenceStatus({
      cadence: { days: 30, setAt: ago(90) },
      lastContactAt: ago(33),
      lastCheckInAt: null,
      now: NOW,
    });
    expect(late.state).toBe('overdue');
    expect(late.daysUntilDue).toBe(-3);
    expect(dueLabel(late)).toBe('3 days overdue');
    // Half a day past due is still "1 day overdue", not "0".
    const justLate = cadenceStatus({
      cadence: { days: 30, setAt: ago(90) },
      lastContactAt: ago(30.5),
      lastCheckInAt: null,
      now: NOW,
    });
    expect(dueLabel(justLate)).toBe('1 day overdue');
  });
});

function task(partial: Partial<TaskLike> & Pick<TaskLike, 'title'>): TaskLike {
  return {
    detail: null,
    status: 'open',
    created_at: ago(1),
    completed_at: null,
    updated_at: ago(1),
    ...partial,
  };
}

function candidate(
  overrides: Partial<CheckInCandidate> = {},
  anchorDaysAgo = 40,
): CheckInCandidate {
  const status = cadenceStatus({
    cadence: { days: 30, setAt: ago(200) },
    lastContactAt: ago(anchorDaysAgo),
    lastCheckInAt: null,
    now: NOW,
  });
  return {
    recordId: RECORD,
    name: 'Wren Halvorsen',
    status,
    cadenceLabel: 'Every month',
    lastContact: 'Last contact: an email to them on Sep 5, 2026.',
    ...overrides,
  };
}

describe('check-in tasks', () => {
  it('adds one for a due record, linked back to its profile', () => {
    const plan = planCheckIns([candidate()], [], NOW);
    expect(plan.create).toEqual([
      {
        recordId: RECORD,
        title: 'Check in with Wren Halvorsen',
        detail: `Keep in touch: every month. Last contact: an email to them on Sep 5, 2026. Profile: ${recordPath(RECORD)}`,
        dueAt: ago(10),
      },
    ]);
  });

  it('adds nothing for a record not yet due', () => {
    expect(planCheckIns([candidate({}, 5)], [], NOW).create).toEqual([]);
  });

  it('never adds a second while one is open or snoozed', () => {
    for (const status of ['open', 'snoozed'] as const) {
      const plan = planCheckIns(
        [candidate()],
        [task({ title: 'check in with  wren halvorsen', status, created_at: ago(90) })],
        NOW,
      );
      expect(plan.create).toEqual([]);
      expect(plan.existing).toEqual(['Check in with Wren Halvorsen']);
    }
  });

  it('never brings back one finished in this round', () => {
    // Made after the last contact (this round), then completed or dismissed.
    for (const status of ['complete', 'cancelled'] as const) {
      const plan = planCheckIns(
        [candidate()],
        [
          task({
            title: 'Check in with Wren Halvorsen',
            status,
            created_at: ago(9),
            completed_at: status === 'complete' ? ago(8) : null,
          }),
        ],
        NOW,
      );
      expect(plan.create).toEqual([]);
    }
  });

  it('adds the next round once the last one was finished before it began', () => {
    const plan = planCheckIns(
      [candidate()],
      [
        task({
          title: 'Check in with Wren Halvorsen',
          status: 'complete',
          created_at: ago(80),
          completed_at: ago(75),
        }),
      ],
      NOW,
    );
    expect(plan.create).toHaveLength(1);
  });

  it('recognises a renamed record’s task by its profile link', () => {
    const plan = planCheckIns(
      [candidate({ name: 'Wren Halvorsen-Ito' })],
      [task({ title: 'Check in with Wren Halvorsen', detail: `Profile: ${recordPath(RECORD)}` })],
      NOW,
    );
    expect(plan.create).toEqual([]);
  });

  it('adds one task when two due records share a name', () => {
    const plan = planCheckIns([candidate(), candidate({ recordId: OTHER })], [], NOW);
    expect(plan.create).toHaveLength(1);
    expect(plan.existing).toEqual(['Check in with Wren Halvorsen']);
  });

  it('takes the last finished or dismissed check-in as when they were last checked in with', () => {
    const tasks = [
      task({ title: checkInTitle('Wren Halvorsen'), status: 'complete', completed_at: ago(12) }),
      task({ title: 'Check in with Wren Halvorsen', status: 'cancelled', updated_at: ago(4) }),
      task({ title: 'Check in with Wren Halvorsen', status: 'open', updated_at: ago(1) }),
      task({ title: 'Check in with Someone Else', status: 'complete', completed_at: ago(1) }),
    ];
    expect(lastCheckInAt(tasks, RECORD, 'Wren Halvorsen')).toBe(ago(4));
    expect(lastCheckInAt([], RECORD, 'Wren Halvorsen')).toBeNull();
  });
});

describe('contact evidence', () => {
  // The relationship index's own rows, so these pin that keep-in-touch counts
  // contact exactly as the profile's Relationship panel does.
  const own = ['nick@tiptop.demo', 'nick@tiptopvc.com'];
  let seq = 0;
  const message = (
    from: string,
    to: string[],
    sentAt: string,
    extra: Partial<EmailMessage> = {},
  ): EmailMessage => {
    seq += 1;
    return {
      id: `m-${seq}`,
      organization_id: 'org',
      thread_id: `t-${seq}`,
      provider: 'google',
      provider_message_id: `p-${seq}`,
      subject: `Subject ${seq}`,
      snippet: '',
      from_name: null,
      from_address: from,
      to_addresses: to,
      cc_addresses: [],
      labels: [],
      is_unread: false,
      sent_at: sentAt,
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
      created_at: sentAt,
      updated_at: sentAt,
      ...extra,
    };
  };
  const meeting = (
    attendees: CalendarEvent['attendees'],
    startsAt: string,
    extra: Partial<CalendarEvent> = {},
  ): CalendarEvent => {
    seq += 1;
    return {
      id: `e-${seq}`,
      organization_id: 'org',
      user_id: 'u',
      provider: 'google',
      provider_event_id: `e-${seq}`,
      title: `Catch-up ${seq}`,
      description: null,
      location: null,
      starts_at: startsAt,
      ends_at: startsAt,
      all_day: false,
      attendees,
      organizer_email: 'nick@tiptop.demo',
      is_private: false,
      created_at: startsAt,
      updated_at: startsAt,
      ...extra,
    };
  };
  const NICK = { name: 'Nick Tippmann', email: 'nick@tiptop.demo', response: 'accepted' };
  const WREN = { name: 'Wren Halvorsen', email: 'wren@tidecrest.example', response: 'accepted' };
  const crowd = Array.from({ length: 20 }, (_, i) => `guest${i}@crowd.example`);

  const index = buildRelationshipIndex(
    {
      messages: [
        message('Wren Halvorsen <wren@tidecrest.example>', ['nick@tiptop.demo'], ago(20)),
        message('nick@tiptop.demo', ['wren@tidecrest.example'], ago(12), {
          cc_addresses: ['ola@tidecrest.example'],
        }),
        // Mail the fund received counts for its sender, never its other recipients.
        message('ola@tidecrest.example', ['wren@tidecrest.example'], ago(2)),
        // A newsletter from the company's domain is not contact with anyone there.
        message('newsletter@tidecrest.example', ['nick@tiptop.demo'], ago(1)),
        // Nor is a broadcast with Wren among twenty others.
        message('nick@tiptop.demo', [...crowd, 'wren@tidecrest.example'], ago(1)),
        // Nick writing from an alias is still Nick writing to her.
        message('nick@tiptopvc.com', ['pia@harbourline.example'], ago(4)),
      ],
      events: [
        meeting([NICK, WREN], ago(5)),
        meeting([NICK, WREN], ahead(3)),
        meeting([NICK, WREN], ago(1), { is_private: true }),
        // Declined by her, or by Nick: not a meeting with her.
        meeting([NICK, { ...WREN, response: 'declined' }], ago(3)),
        meeting([{ ...NICK, response: 'declined' }, WREN], ago(2)),
      ],
      threads: [],
      ownAddresses: own,
    },
    NOW,
  );
  const evidence = contactEvidenceFrom(index, NOW);
  const person = (emails: string[]) => ({
    id: RECORD,
    kind: 'person' as const,
    name: 'Someone',
    domain: null,
    emails,
  });
  const company = (domain: string) => ({
    id: OTHER,
    kind: 'company' as const,
    name: 'Tidecrest',
    domain,
    emails: [],
  });

  it('finds the last email or past meeting, and the next meeting, for a person', () => {
    expect(evidence.evidenceFor(person(['WREN@tidecrest.example']))).toEqual({
      lastContactAt: ago(5),
      lastContactKind: 'meeting',
      nextMeetingAt: ahead(3),
    });
  });

  it('counts what an outsider sent, but never an address of the fund itself', () => {
    expect(evidence.evidenceFor(person(['ola@tidecrest.example'])).lastContactAt).toBe(ago(2));
    expect(evidence.evidenceFor(person(['nick@tiptop.demo'])).lastContactAt).toBeNull();
  });

  it('counts mail from Nick’s aliases as Nick’s', () => {
    expect(evidence.evidenceFor(person(['pia@harbourline.example']))).toMatchObject({
      lastContactAt: ago(4),
      lastContactKind: 'outbound',
    });
    expect(evidence.evidenceFor(person(['nick@tiptopvc.com'])).lastContactAt).toBeNull();
  });

  it('finds a company by its people, never by a newsletter or a broadcast', () => {
    expect(evidence.evidenceFor(company('tidecrest.example'))).toMatchObject({
      lastContactAt: ago(2),
      lastContactKind: 'inbound',
    });
    expect(evidence.evidenceFor(company('elsewhere.example')).lastContactAt).toBeNull();
  });

  it('agrees with the Relationship panel’s evidence for the same record', () => {
    const fromIndex = evidenceFor(index, ['wren@tidecrest.example'], NOW).evidence;
    const fromCard = evidence.evidenceFor(person(['wren@tidecrest.example']));
    expect(fromCard.lastContactAt).toBe(fromIndex.lastContactAt);
    expect(fromCard.nextMeetingAt).toBe(fromIndex.nextMeetingAt);
  });
});
