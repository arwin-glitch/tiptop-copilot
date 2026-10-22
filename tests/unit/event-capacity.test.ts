import { describe, expect, it } from 'vitest';
import {
  capacityViolations,
  needsApproval,
  planAddGuests,
  planHostStatus,
  planInviteResponse,
  planPromote,
  planPublicRegistration,
  planRemoveGuests,
  rowsAfterPlan,
  seatsLeft,
  waitlistOn,
  type EngineContext,
  type PublicRegistrationInput,
} from '@/lib/events/capacity';
import type {
  EventGuest,
  EventGuestSession,
  EventRegistrationSettings,
  EventSession,
} from '@/lib/types/domain';

/**
 * The seat engine (lib/events/capacity.ts): who is Going, Pending or on the
 * Waitlist, per session, plus-ones included. Pure; fictional data.
 */

const ORG = '00000000-0000-4000-8000-00000000a001';
const EVENT = '00000000-0000-4000-8000-00000000e001';
const S1 = '00000000-0000-4000-8000-00000000c001';
const S2 = '00000000-0000-4000-8000-00000000c002';
const NOW = '2030-01-10T12:00:00.000Z';

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

function registration(over: Partial<EventRegistrationSettings> = {}): EventRegistrationSettings {
  return {
    open: true,
    closes_at: null,
    show_remaining: true,
    response_set: {
      maybe: true,
      labels: { going: 'Going', maybe: 'Maybe', not_going: "Can't go" },
    },
    plus_ones: { max: 1, per_session: true, collect_email: false, ask_questions: true },
    waitlist: true,
    auto_promote: false,
    claim_window_hours: null,
    request_invite: true,
    guest_wall: 'hidden',
    ...over,
  };
}

function session(
  id: string,
  capacity: number | null,
  over: Partial<EventSession> = {},
): EventSession {
  return {
    id,
    organization_id: ORG,
    event_id: EVENT,
    name: id === S1 ? 'Meeting' : 'Reception',
    description: null,
    starts_at: '2030-02-01T19:00:00.000Z',
    ends_at: '2030-02-01T23:00:00.000Z',
    venue: null,
    capacity,
    requires_approval: null,
    waitlist: null,
    visible_to_tags: [],
    position: id === S1 ? 0 : 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function guest(id: string, over: Partial<EventGuest> = {}): EventGuest {
  return {
    id,
    organization_id: ORG,
    event_id: EVENT,
    parent_guest_id: null,
    email: `${id.slice(-4)}@example.com`,
    first_name: 'Test',
    last_name: id.slice(-4),
    company: null,
    title: null,
    phone: null,
    record_id: null,
    tags: [],
    host_note: null,
    answers: {},
    source: 'invite',
    token_version: 1,
    show_on_wall: false,
    referral_code: null,
    utm: null,
    ip_hash: null,
    notified_status: {},
    registered_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function row(
  guestId: string,
  sessionId: string,
  status: EventGuestSession['status'],
  requestedAt = NOW,
): EventGuestSession {
  return {
    guest_id: guestId,
    session_id: sessionId,
    organization_id: ORG,
    event_id: EVENT,
    status,
    requested_at: requestedAt,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    claim_expires_at: null,
    checked_in_at: null,
    checked_in_by: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function ctx(
  over: Partial<EngineContext> & {
    reg?: Partial<EventRegistrationSettings>;
    access?: 'open' | 'approval' | 'invite_only';
    cap?: number | null;
  } = {},
): EngineContext {
  return {
    event: {
      id: EVENT,
      organization_id: ORG,
      access: over.access ?? 'open',
      capacity: over.cap ?? null,
      registration: registration(over.reg),
    },
    sessions: over.sessions ?? [session(S1, 2), session(S2, null)],
    guests: over.guests ?? [],
    rows: over.rows ?? [],
    now: NOW,
    newId: nextId,
  };
}

function publicInput(
  email: string,
  over: Partial<PublicRegistrationInput> = {},
): PublicRegistrationInput {
  return {
    person: {
      email,
      first_name: 'Sam',
      last_name: 'Sample',
      company: null,
      title: null,
      phone: null,
    },
    sessionIds: [S1],
    answers: {},
    plusOnes: [],
    showOnWall: false,
    request: false,
    referralCode: null,
    utm: null,
    ipHash: null,
    ...over,
  };
}

describe('rules', () => {
  it('asks approval of self-registered people on approval events, never of host-added guests', () => {
    const s = session(S1, null);
    expect(needsApproval(s, { access: 'approval' }, 'public')).toBe(true);
    expect(needsApproval(s, { access: 'approval' }, 'request')).toBe(true);
    expect(needsApproval(s, { access: 'approval' }, 'invite')).toBe(false);
    expect(needsApproval(s, { access: 'open' }, 'public')).toBe(false);
    expect(needsApproval({ requires_approval: true }, { access: 'open' }, 'invite')).toBe(true);
    expect(needsApproval({ requires_approval: false }, { access: 'approval' }, 'public')).toBe(
      false,
    );
  });

  it('inherits the waitlist setting unless the session overrides it', () => {
    const event = { registration: registration({ waitlist: false }) };
    expect(waitlistOn({ waitlist: null }, event)).toBe(false);
    expect(waitlistOn({ waitlist: true }, event)).toBe(true);
  });

  it('counts seats left from Going rows only, and the event cap too', () => {
    const rows = [row('g1', S1, 'going'), row('g2', S1, 'pending'), row('g3', S2, 'going')];
    expect(seatsLeft(session(S1, 2), { capacity: null }, rows)).toBe(1);
    expect(seatsLeft(session(S2, null), { capacity: null }, rows)).toBeNull();
    expect(seatsLeft(session(S2, null), { capacity: 2 }, rows)).toBe(0);
  });
});

describe('public registration', () => {
  it('seats a party while it fits, then waitlists it whole', () => {
    const first = planPublicRegistration(ctx(), publicInput('a@example.com'));
    expect(first.kind).toBe('planned');
    if (first.kind !== 'planned') return;
    expect(first.outcome.sessions[S1]).toBe('going');

    // One seat left; a guest bringing a plus-one does not fit → the party waits.
    const c = ctx({ guests: first.plan.upsertGuests, rows: first.plan.upsertRows });
    const party = planPublicRegistration(
      c,
      publicInput('b@example.com', {
        plusOnes: [
          {
            fields: {
              email: null,
              first_name: 'Pat',
              last_name: null,
              company: null,
              title: null,
              phone: null,
            },
            answers: {},
            sessionIds: [S1],
          },
        ],
      }),
    );
    expect(party.kind).toBe('planned');
    if (party.kind !== 'planned') return;
    expect(party.outcome.sessions[S1]).toBe('waitlist');
    expect(party.outcome.plusOnes[0]!.sessions[S1]).toBe('waitlist');
    expect(party.plan.upsertRows.every((r) => r.status === 'waitlist')).toBe(true);
  });

  it('turns a full session away when it has no waitlist', () => {
    const c = ctx({
      sessions: [session(S1, 1)],
      reg: { waitlist: false },
      guests: [guest('g1')],
      rows: [row('g1', S1, 'going')],
    });
    expect(planPublicRegistration(c, publicInput('c@example.com')).kind).toBe('full');
  });

  it('says "already registered" for an email on the list, case-insensitively', () => {
    const c = ctx({ guests: [guest('g1', { email: 'known@example.com' })] });
    expect(planPublicRegistration(c, publicInput('Known@Example.com'.toLowerCase())).kind).toBe(
      'already_registered',
    );
  });

  it('puts approval events and invite requests in Pending', () => {
    const approval = planPublicRegistration(
      ctx({ access: 'approval' }),
      publicInput('d@example.com'),
    );
    expect(approval.kind === 'planned' && approval.outcome.sessions[S1]).toBe('pending');
    const request = planPublicRegistration(
      ctx({ access: 'invite_only' }),
      publicInput('e@example.com', { request: true }),
    );
    expect(request.kind === 'planned' && request.outcome.sessions[S1]).toBe('pending');
    expect(request.kind === 'planned' && request.plan.upsertGuests[0]!.source).toBe('request');
  });

  it('refuses more plus-ones than allowed', () => {
    const po = {
      fields: {
        email: null,
        first_name: 'X',
        last_name: null,
        company: null,
        title: null,
        phone: null,
      },
      answers: {},
      sessionIds: null,
    };
    const result = planPublicRegistration(
      ctx(),
      publicInput('f@example.com', { plusOnes: [po, po] }),
    );
    expect(result.kind).toBe('invalid');
  });

  it('respects the event-wide capacity across sessions', () => {
    const c = ctx({
      cap: 1,
      guests: [guest('g1')],
      rows: [row('g1', S2, 'going')],
    });
    const result = planPublicRegistration(c, publicInput('g@example.com', { sessionIds: [S2] }));
    expect(result.kind === 'planned' && result.outcome.sessions[S2]).toBe('waitlist');
  });
});

describe('personal-link responses', () => {
  const g1 = guest('00000000-0000-4000-8000-0000000000a1');
  const g2 = guest('00000000-0000-4000-8000-0000000000a2');

  it('seats an invited guest and their plus-one together', () => {
    const c = ctx({ guests: [g1], rows: [row(g1.id, S1, 'invited')] });
    const result = planInviteResponse(c, {
      guestId: g1.id,
      responses: { [S1]: 'going' },
      plusOnes: [
        {
          fields: {
            email: null,
            first_name: 'Rowan',
            last_name: null,
            company: null,
            title: null,
            phone: null,
          },
          answers: {},
          sessionIds: [S1],
        },
      ],
    });
    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.outcome.sessions[S1]).toBe('going');
    expect(result.plan.upsertGuests.filter((g) => g.parent_guest_id === g1.id)).toHaveLength(1);
    expect(result.plan.upsertRows.filter((r) => r.status === 'going')).toHaveLength(2);
  });

  it('keeps a host decline final', () => {
    const c = ctx({ guests: [g1], rows: [row(g1.id, S1, 'declined')] });
    const result = planInviteResponse(c, { guestId: g1.id, responses: { [S1]: 'going' } });
    expect(result.kind === 'planned' && result.outcome.sessions[S1]).toBe('declined');
  });

  it('cancelling frees the seat, and auto-promote seats the first waitlisted party that fits', () => {
    const w1 = guest('00000000-0000-4000-8000-0000000000b1');
    const w2 = guest('00000000-0000-4000-8000-0000000000b2');
    const w1po = guest('00000000-0000-4000-8000-0000000000b3', {
      parent_guest_id: w1.id,
      email: null,
      source: 'plus_one',
    });
    const c = ctx({
      reg: { auto_promote: true },
      sessions: [session(S1, 2)],
      guests: [g1, g2, w1, w1po, w2],
      rows: [
        row(g1.id, S1, 'going'),
        row(g2.id, S1, 'going'),
        // w1 asked first but brings a plus-one: two seats needed, one free.
        row(w1.id, S1, 'waitlist', '2030-01-01T00:00:00.000Z'),
        row(w1po.id, S1, 'waitlist', '2030-01-01T00:00:00.000Z'),
        row(w2.id, S1, 'waitlist', '2030-01-02T00:00:00.000Z'),
      ],
    });
    const result = planInviteResponse(c, { guestId: g1.id, responses: { [S1]: 'not_going' } });
    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.outcome.sessions[S1]).toBe('not_going');
    expect(result.outcome.promoted.map((p) => p.guestId)).toEqual([w2.id]);
    const after = rowsAfterPlan(c.rows, result.plan);
    expect(after.filter((r) => r.status === 'going')).toHaveLength(2);
    expect(capacityViolations(c.rows, after, c.sessions, null)).toEqual([]);
  });

  it('does not auto-promote when the event has it off (the LP default)', () => {
    const w = guest('00000000-0000-4000-8000-0000000000c1');
    const c = ctx({
      sessions: [session(S1, 1)],
      guests: [g1, w],
      rows: [row(g1.id, S1, 'going'), row(w.id, S1, 'waitlist')],
    });
    const result = planInviteResponse(c, { guestId: g1.id, responses: { [S1]: 'not_going' } });
    expect(result.kind === 'planned' && result.outcome.promoted).toEqual([]);
  });

  it('waitlists only the new plus-one of a seated guest when the session is full', () => {
    const c = ctx({
      sessions: [session(S1, 1)],
      guests: [g1],
      rows: [row(g1.id, S1, 'going')],
    });
    const result = planInviteResponse(c, {
      guestId: g1.id,
      responses: { [S1]: 'going' },
      plusOnes: [
        {
          fields: {
            email: null,
            first_name: 'Kit',
            last_name: null,
            company: null,
            title: null,
            phone: null,
          },
          answers: {},
          sessionIds: [S1],
        },
      ],
    });
    expect(result.kind).toBe('planned');
    if (result.kind !== 'planned') return;
    expect(result.outcome.sessions[S1]).toBe('going');
    expect(result.outcome.plusOnes[0]!.sessions[S1]).toBe('waitlist');
  });

  it('refuses Maybe when the event does not offer it', () => {
    const c = ctx({
      reg: {
        response_set: { maybe: false, labels: { going: 'Going', maybe: 'Maybe', not_going: 'No' } },
      },
      guests: [g1],
    });
    expect(planInviteResponse(c, { guestId: g1.id, responses: { [S1]: 'maybe' } }).kind).toBe(
      'invalid',
    );
  });
});

describe('owner decisions', () => {
  const a = guest('00000000-0000-4000-8000-0000000000d1');
  const b = guest('00000000-0000-4000-8000-0000000000d2');
  const c3 = guest('00000000-0000-4000-8000-0000000000d3');

  it('approves pending guests while seats last and reports the rest as full', () => {
    const c = ctx({
      sessions: [session(S1, 1)],
      guests: [a, b],
      rows: [row(a.id, S1, 'pending'), row(b.id, S1, 'pending')],
    });
    const { plan, outcome } = planHostStatus(c, {
      guestIds: [a.id, b.id],
      sessionIds: null,
      to: 'going',
      from: ['pending'],
      by: 'owner',
      note: 'Welcome',
    });
    expect(outcome.changed.map((x) => x.guestId)).toEqual([a.id]);
    expect(outcome.full.map((x) => x.guestId)).toEqual([b.id]);
    expect(plan.upsertRows[0]).toMatchObject({
      status: 'going',
      decision_note: 'Welcome',
      decided_by: 'owner',
    });
  });

  it('can force a seat past capacity', () => {
    const c = ctx({ sessions: [session(S1, 0)], guests: [a], rows: [row(a.id, S1, 'pending')] });
    const { plan, outcome } = planHostStatus(c, {
      guestIds: [a.id],
      sessionIds: [S1],
      to: 'going',
      by: 'owner',
      force: true,
    });
    expect(outcome.changed).toHaveLength(1);
    expect(plan.force).toBe(true);
  });

  it('promotes waitlisted guests FIFO among those chosen', () => {
    const c = ctx({
      sessions: [session(S1, 2)],
      guests: [a, b, c3],
      rows: [
        row(a.id, S1, 'going'),
        row(b.id, S1, 'waitlist', '2030-01-02T00:00:00.000Z'),
        row(c3.id, S1, 'waitlist', '2030-01-01T00:00:00.000Z'),
      ],
    });
    const { outcome } = planPromote(c, { guestIds: [b.id, c3.id], sessionIds: [S1], by: 'owner' });
    expect(outcome.promoted.map((p) => p.guestId)).toEqual([c3.id]);
    expect(outcome.full.map((f) => f.guestId)).toEqual([b.id]);
  });

  it('adds guests deduplicated on email, linking the existing row', () => {
    const c = ctx({
      guests: [
        guest('00000000-0000-4000-8000-0000000000e1', { email: 'dup@example.com', tags: ['LP'] }),
      ],
    });
    const { plan, outcome } = planAddGuests(c, {
      people: [
        {
          email: 'dup@example.com',
          first_name: null,
          last_name: null,
          company: null,
          title: null,
          phone: null,
          tags: ['VIP'],
          record_id: '00000000-0000-4000-8000-0000000000f1',
        },
        {
          email: 'new@example.com',
          first_name: 'New',
          last_name: null,
          company: null,
          title: null,
          phone: null,
        },
        {
          email: 'NEW@example.com',
          first_name: 'Again',
          last_name: null,
          company: null,
          title: null,
          phone: null,
        },
      ],
      sessionIds: [S1],
      status: 'invited',
      source: 'host',
      by: 'owner',
    });
    expect(outcome.added).toHaveLength(1);
    expect(outcome.merged).toHaveLength(1);
    const merged = plan.upsertGuests.find((g) => g.email === 'dup@example.com')!;
    expect(merged.tags).toEqual(['LP', 'VIP']);
    expect(merged.record_id).toBe('00000000-0000-4000-8000-0000000000f1');
    expect(plan.upsertRows.every((r) => r.status === 'invited')).toBe(true);
  });

  it('removing a going guest auto-promotes when allowed', () => {
    const c = ctx({
      reg: { auto_promote: true },
      sessions: [session(S1, 1)],
      guests: [a, b],
      rows: [row(a.id, S1, 'going'), row(b.id, S1, 'waitlist')],
    });
    const { plan, outcome } = planRemoveGuests(c, [a.id]);
    expect(outcome.removed).toBe(1);
    expect(outcome.promoted.map((p) => p.guestId)).toEqual([b.id]);
    expect(plan.deleteGuestIds).toEqual([a.id]);
  });
});

describe('the capacity invariant (what event_register enforces)', () => {
  it('refuses a plan that adds Going past capacity, allows one that does not add', () => {
    const sessions = [session(S1, 1)];
    const before = [row('g1', S1, 'going')];
    expect(capacityViolations(before, [...before, row('g2', S1, 'going')], sessions, null)).toEqual(
      [S1],
    );
    // Already over (an owner forced it) and not growing: fine.
    const over = [row('g1', S1, 'going'), row('g2', S1, 'going')];
    expect(capacityViolations(over, over, sessions, null)).toEqual([]);
    expect(
      capacityViolations(before, [...before, row('g3', S1, 'waitlist')], sessions, null),
    ).toEqual([]);
  });
});

describe('approval cannot be skipped (security + guests review)', () => {
  // The AGM shape: invite-only, "Request an invite" on, sessions inherit approval.
  const agm = () => ctx({ access: 'invite_only', sessions: [session(S1, 50), session(S2, 50)] });

  /** Apply one personal-link response on top of a context; returns the next context. */
  function respond(
    c: EngineContext,
    guestId: string,
    responses: Record<string, 'going' | 'maybe' | 'not_going'>,
  ): { c: EngineContext; sessions: Record<string, string> } {
    const r = planInviteResponse(c, { guestId, responses });
    if (r.kind !== 'planned') throw new Error(`unexpected ${r.kind}`);
    const guests = [
      ...c.guests.filter((g) => !r.plan.upsertGuests.some((u) => u.id === g.id)),
      ...r.plan.upsertGuests,
    ];
    return {
      c: { ...c, guests, rows: rowsAfterPlan(c.rows, r.plan) },
      sessions: r.outcome.sessions,
    };
  }

  function requested(): { c: EngineContext; id: string } {
    const c = agm();
    const r = planPublicRegistration(
      c,
      publicInput('stranger@example.com', { request: true, sessionIds: [S1, S2] }),
    );
    if (r.kind !== 'planned') throw new Error('not planned');
    return {
      c: { ...c, guests: r.plan.upsertGuests, rows: rowsAfterPlan(c.rows, r.plan) },
      id: r.outcome.guestId,
    };
  }

  it('an invite request always needs the host, whatever the session says', () => {
    expect(needsApproval({ requires_approval: null }, { access: 'invite_only' }, 'request')).toBe(
      true,
    );
    expect(needsApproval({ requires_approval: false }, { access: 'open' }, 'request')).toBe(true);
    expect(needsApproval({ requires_approval: null }, { access: 'invite_only' }, 'invite')).toBe(
      false,
    );
  });

  it('pending, then Maybe, then Going stays Pending', () => {
    const { c, id } = requested();
    const maybe = respond(c, id, { [S1]: 'maybe', [S2]: 'maybe' });
    expect(maybe.sessions).toEqual({ [S1]: 'pending', [S2]: 'pending' });
    const going = respond(maybe.c, id, { [S1]: 'going', [S2]: 'going' });
    expect(going.sessions).toEqual({ [S1]: 'pending', [S2]: 'pending' });
    expect(going.c.rows.filter((r) => r.guest_id === id).map((r) => r.status)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('pending, then Can not go, then Going asks again (Pending), and Maybe too', () => {
    const { c, id } = requested();
    const out = respond(c, id, { [S1]: 'not_going' });
    expect(out.sessions[S1]).toBe('not_going');
    expect(respond(out.c, id, { [S1]: 'going' }).sessions[S1]).toBe('pending');
    expect(respond(out.c, id, { [S1]: 'maybe' }).sessions[S1]).toBe('pending');
  });

  it('an approval event self-registrant cannot reach Maybe or Going without the host', () => {
    const c = ctx({ access: 'approval', sessions: [session(S1, 10)] });
    const r = planPublicRegistration(c, publicInput('self@example.com'));
    if (r.kind !== 'planned') throw new Error('not planned');
    const next = { ...c, guests: r.plan.upsertGuests, rows: rowsAfterPlan(c.rows, r.plan) };
    const out = respond(next, r.outcome.guestId, { [S1]: 'not_going' });
    expect(respond(out.c, r.outcome.guestId, { [S1]: 'maybe' }).sessions[S1]).toBe('pending');
    expect(respond(out.c, r.outcome.guestId, { [S1]: 'going' }).sessions[S1]).toBe('pending');
  });

  it('an approved requester who cancels and comes back is Going again', () => {
    const { c, id } = requested();
    const approved = planHostStatus(c, {
      guestIds: [id],
      sessionIds: [S1],
      to: 'going',
      from: ['pending'],
      by: 'owner',
    });
    const after = { ...c, rows: rowsAfterPlan(c.rows, approved.plan) };
    const out = respond(after, id, { [S1]: 'not_going' });
    expect(respond(out.c, id, { [S1]: 'going' }).sessions[S1]).toBe('going');
    expect(respond(out.c, id, { [S1]: 'maybe' }).sessions[S1]).toBe('maybe');
    // Moved back to Pending by the host: no longer vetted.
    const repend = planHostStatus(after, {
      guestIds: [id],
      sessionIds: [S1],
      to: 'pending',
      by: 'owner',
    });
    const again = respond({ ...after, rows: rowsAfterPlan(after.rows, repend.plan) }, id, {
      [S1]: 'not_going',
    });
    expect(respond(again.c, id, { [S1]: 'going' }).sessions[S1]).toBe('pending');
  });

  it('invited guests are unaffected: Maybe then Going seats them', () => {
    const inv = guest('00000000-0000-4000-8000-0000000000f9');
    const c = ctx({ access: 'invite_only', guests: [inv], rows: [row(inv.id, S1, 'invited')] });
    const maybe = respond(c, inv.id, { [S1]: 'maybe' });
    expect(maybe.sessions[S1]).toBe('maybe');
    expect(respond(maybe.c, inv.id, { [S1]: 'going' }).sessions[S1]).toBe('going');
  });
});

describe('the waitlist is first in, first out (guests review)', () => {
  const host = guest('00000000-0000-4000-8000-0000000000aa');
  const waiter = guest('00000000-0000-4000-8000-0000000000ab');
  const late = guest('00000000-0000-4000-8000-0000000000ac');

  it('a newcomer joins the back while someone waiting would fit the free seat', () => {
    // One seat free (the host freed it, auto-promote off): the waiting guest gets it.
    const c = ctx({
      sessions: [session(S1, 2)],
      guests: [host, waiter],
      rows: [row(host.id, S1, 'going'), row(waiter.id, S1, 'waitlist')],
    });
    const pub = planPublicRegistration(c, publicInput('new@example.com'));
    expect(pub.kind === 'planned' && pub.outcome.sessions[S1]).toBe('waitlist');
    const invited = ctx({
      sessions: [session(S1, 2)],
      guests: [host, waiter, late],
      rows: [
        row(host.id, S1, 'going'),
        row(waiter.id, S1, 'waitlist'),
        row(late.id, S1, 'invited'),
      ],
    });
    const r = planInviteResponse(invited, { guestId: late.id, responses: { [S1]: 'going' } });
    expect(r.kind === 'planned' && r.outcome.sessions[S1]).toBe('waitlist');
  });

  it('a waitlisted guest cannot jump the queue through Maybe', () => {
    const first = guest('00000000-0000-4000-8000-0000000000ad');
    const c = ctx({
      sessions: [session(S1, 2)],
      guests: [host, first, waiter],
      rows: [
        row(host.id, S1, 'going'),
        row(first.id, S1, 'waitlist', '2030-01-01T00:00:00.000Z'),
        row(waiter.id, S1, 'waitlist', '2030-01-05T00:00:00.000Z'),
      ],
    });
    const maybe = planInviteResponse(c, { guestId: waiter.id, responses: { [S1]: 'maybe' } });
    if (maybe.kind !== 'planned') throw new Error('not planned');
    const next = { ...c, rows: rowsAfterPlan(c.rows, maybe.plan) };
    const going = planInviteResponse(next, { guestId: waiter.id, responses: { [S1]: 'going' } });
    expect(going.kind === 'planned' && going.outcome.sessions[S1]).toBe('waitlist');
  });

  it('promotes a plus-one waitlisted alone behind a Going host', () => {
    const kid = guest('00000000-0000-4000-8000-0000000000ae', {
      parent_guest_id: host.id,
      email: null,
      source: 'plus_one',
    });
    const other = guest('00000000-0000-4000-8000-0000000000af');
    const c = ctx({
      reg: { auto_promote: true },
      sessions: [session(S1, 2)],
      guests: [host, kid, other],
      rows: [row(host.id, S1, 'going'), row(other.id, S1, 'going'), row(kid.id, S1, 'waitlist')],
    });
    // A seat frees: the +1 is first in line.
    const freed = planInviteResponse(c, { guestId: other.id, responses: { [S1]: 'not_going' } });
    expect(freed.kind === 'planned' && freed.outcome.promoted.map((p) => p.guestId)).toEqual([
      kid.id,
    ]);
    // And the host's bulk "Promote" seats them too.
    const roomy = ctx({
      sessions: [session(S1, 3)],
      guests: [host, kid],
      rows: [row(host.id, S1, 'going'), row(kid.id, S1, 'waitlist')],
    });
    const promoted = planPromote(roomy, { guestIds: [host.id], sessionIds: [S1], by: 'owner' });
    expect(promoted.outcome.promoted).toEqual([{ guestId: kid.id, sessionId: S1, partySize: 1 }]);
  });

  it('bulk "Move to Waitlist" puts people at the back', () => {
    const c = ctx({
      sessions: [session(S1, 5)],
      guests: [host],
      rows: [row(host.id, S1, 'going', '2030-01-01T00:00:00.000Z')],
    });
    const { plan } = planHostStatus(c, {
      guestIds: [host.id],
      sessionIds: [S1],
      to: 'waitlist',
      by: 'owner',
    });
    expect(plan.upsertRows[0]).toMatchObject({ status: 'waitlist', requested_at: NOW });
  });
});
