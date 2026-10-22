import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { PublicRsvpInput } from '@/lib/events/registration';
import { applyPlan, withEventLock } from '@/lib/services/event-register';
import { registerPublic } from '@/lib/services/event-rsvp';
import type { EventRecord, EventSession } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Two RSVPs for the last seat can never both win (D-075). On the demo store
 * the plan-and-apply runs under a per-event lock with the same capacity check
 * event_register() makes in SQL; the SQL itself is checked statically below
 * (the repo has no Postgres to run it). Fictional data only.
 */

const SQL = readFileSync(
  path.resolve(
    import.meta.dirname,
    '../../supabase/migrations/20261023000200_event_register_fn.sql',
  ),
  'utf8',
);

let h: Harness;
let event: EventRecord;
let meeting: EventSession;

function input(email: string): PublicRsvpInput {
  return {
    formToken: 'unused-here',
    firstName: 'Casey',
    lastName: 'Example',
    email,
    sessions: [DEMO_EVENT_IDS.sessionMeeting],
    answers: {},
    plusOnes: [],
    showOnWall: false,
    request: false,
  };
}

beforeEach(async () => {
  h = await createHarness();
  const org = h.auth.organizationId;
  // The demo meeting has one person Going: make one seat left, open registration.
  event = await h.store.update('events', org, DEMO_EVENT_IDS.annualMeeting, { access: 'open' });
  meeting = await h.store.update('event_sessions', org, DEMO_EVENT_IDS.sessionMeeting, {
    capacity: 2,
  });
});

afterEach(async () => {
  await h.dispose();
});

async function sessions() {
  return h.store.list('event_sessions', h.auth.organizationId, { eq: { event_id: event.id } });
}

describe('last-seat races', () => {
  it('seats exactly one of two simultaneous RSVPs and waitlists the other', async () => {
    const all = await sessions();
    const [a, b] = await Promise.all([
      registerPublic(h.store, event, all, input('first.racer@example.com'), { ipHash: null }),
      registerPublic(h.store, event, all, input('second.racer@example.com'), { ipHash: null }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const statuses = [
      a.value.outcome.sessions[meeting.id],
      b.value.outcome.sessions[meeting.id],
    ].sort();
    expect(statuses).toEqual(['going', 'waitlist']);
    const going = await h.store.count('event_guest_sessions', h.auth.organizationId, {
      eq: { session_id: meeting.id, status: 'going' },
    });
    expect(going).toBe(2);
  });

  it('turns the loser away when the session has no waitlist', async () => {
    await h.store.update('event_sessions', h.auth.organizationId, meeting.id, { waitlist: false });
    const all = await sessions();
    const results = await Promise.all(
      ['one@example.com', 'two@example.com', 'three@example.com'].map((email) =>
        registerPublic(h.store, event, all, input(email), { ipHash: null }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.message === 'This event is full.')).toHaveLength(
      2,
    );
  });

  it('answers the same email twice with the neutral message', async () => {
    const all = await sessions();
    const [a, b] = await Promise.all([
      registerPublic(h.store, event, all, input('twice@example.com'), { ipHash: null }),
      registerPublic(h.store, event, all, input('twice@example.com'), { ipHash: null }),
    ]);
    const failures = [a, b].filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
    expect(!failures[0]!.ok && failures[0]!.error.message).toMatch(/already registered/i);
  });

  it('refuses a plan that would overfill a session unless forced', async () => {
    const org = h.auth.organizationId;
    const now = new Date().toISOString();
    const guestId = '00000000-0000-4000-8000-00000000aaa1';
    const plan = {
      upsertGuests: [
        {
          id: guestId,
          organization_id: org,
          event_id: event.id,
          parent_guest_id: null,
          email: 'over@example.com',
          first_name: 'Over',
          last_name: null,
          company: null,
          title: null,
          phone: null,
          record_id: null,
          tags: [],
          host_note: null,
          answers: {},
          source: 'host' as const,
          token_version: 1,
          show_on_wall: false,
          referral_code: null,
          utm: null,
          ip_hash: null,
          notified_status: {},
          registered_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      deleteGuestIds: [],
      upsertRows: [
        {
          guest_id: guestId,
          session_id: meeting.id,
          organization_id: org,
          event_id: event.id,
          status: 'going' as const,
          requested_at: now,
          decided_by: null,
          decided_at: null,
          decision_note: null,
          claim_expires_at: null,
          checked_in_at: null,
          checked_in_by: null,
          created_at: now,
          updated_at: now,
        },
      ],
      deleteRows: [],
      force: false,
    };
    await h.store.update('event_sessions', org, meeting.id, { capacity: 1 });
    expect(await withEventLock(event.id, () => applyPlan(h.store, org, event.id, plan))).toEqual({
      ok: false,
      reason: 'capacity',
    });
    expect(
      await withEventLock(event.id, () =>
        applyPlan(h.store, org, event.id, { ...plan, force: true }),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a plan that writes into another event', async () => {
    const org = h.auth.organizationId;
    const result = await applyPlan(h.store, org, event.id, {
      upsertGuests: [],
      deleteGuestIds: [],
      upsertRows: [
        {
          guest_id: DEMO_EVENT_IDS.guestAvery,
          session_id: DEMO_EVENT_IDS.sessionPutting,
          organization_id: org,
          event_id: event.id,
          status: 'going',
          requested_at: null,
          decided_by: null,
          decided_at: null,
          decision_note: null,
          claim_expires_at: null,
          checked_in_at: null,
          checked_in_by: null,
          created_at: '2030-01-01T00:00:00.000Z',
          updated_at: '2030-01-01T00:00:00.000Z',
        },
      ],
      deleteRows: [],
      force: false,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('event_register() SQL', () => {
  const code = SQL.split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('is a server-only security definer function with a fixed search path', () => {
    expect(code).toMatch(
      /create or replace function event_register\(p_organization_id uuid, p_event_id uuid, p_plan jsonb\)/,
    );
    expect(code).toMatch(/security definer\s+set search_path = public/);
    expect(code).toMatch(/revoke all on function event_register\(uuid, uuid, jsonb\) from public;/);
    expect(code).toMatch(
      /revoke all on function event_register\(uuid, uuid, jsonb\) from anon, authenticated;/,
    );
    expect(code).toMatch(
      /grant execute on function event_register\(uuid, uuid, jsonb\) to service_role;/,
    );
  });

  it('locks the event, then its sessions in id order, before counting', () => {
    const lockEvent = code.indexOf(
      'from events\n    where id = p_event_id and organization_id = p_organization_id\n    for update',
    );
    const lockSessions = code.search(
      /from event_sessions\s+where event_id = p_event_id and organization_id = p_organization_id\s+order by id\s+for update/,
    );
    const count = code.indexOf('into v_going_before');
    expect(lockEvent).toBeGreaterThan(0);
    expect(lockSessions).toBeGreaterThan(lockEvent);
    expect(count).toBeGreaterThan(lockSessions);
  });

  it('forces organization and event from its arguments on every write', () => {
    expect(code).toMatch(/values \(\s*v_guest\.id, p_organization_id, p_event_id,/);
    expect(code).toMatch(/v_row\.guest_id, v_row\.session_id, p_organization_id, p_event_id,/);
    expect(code).toMatch(
      /where event_guests\.organization_id = p_organization_id\s+and event_guests\.event_id = p_event_id/,
    );
  });

  it('refuses the whole plan past capacity unless forced, and maps duplicate emails', () => {
    expect(code).toMatch(/if v_after > v_session\.capacity and v_after > v_before then/);
    expect(code).toMatch(/if v_after > v_event\.capacity and v_after > v_event_before then/);
    expect(code).toMatch(/if not v_force then/);
    expect(code).toMatch(
      /when unique_violation then\s+return jsonb_build_object\('ok', false, 'reason', 'duplicate_email'\)/,
    );
    expect(code).toMatch(
      /when sqlstate 'EV001' then\s+return jsonb_build_object\('ok', false, 'reason', 'capacity'\)/,
    );
  });

  it('never lets a plan clobber a check-in or a host note', () => {
    expect(code).toMatch(
      /checked_in_at = coalesce\(excluded\.checked_in_at, event_guest_sessions\.checked_in_at\)/,
    );
    const update = code.slice(
      code.indexOf('on conflict (id) do update set'),
      code.indexOf('get diagnostics'),
    );
    expect(update).not.toMatch(/host_note\s*=/);
    expect(update).not.toMatch(/notified_status\s*=/);
    expect(update).not.toMatch(/token_version\s*=/);
  });
});
