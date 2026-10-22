import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import { RSVP_TOKEN_PURPOSE, inviteToken, verifyGuestToken } from '@/lib/events/tokens';
import type { EventOwner } from '@/lib/services/events';
import {
  addGuests,
  bulkGuests,
  exportGuests,
  getGuestDetail,
  importGuests,
  listGuests,
  markNotified,
  needsNotifying,
  notifyKindFor,
  resolveAudience,
  updateGuest,
} from '@/lib/services/event-guests';
import {
  addWalkIn,
  checkInGuest,
  currentSession,
  doorList,
  liveSession,
  type CheckinActor,
} from '@/lib/services/event-checkin';
import {
  buildPublicPage,
  buildTicket,
  resolveInvite,
  resolvePublicEvent,
  resolveRemembered,
} from '@/lib/services/event-public';
import {
  addSession,
  getRegistration,
  removeSession,
  updateRegistration,
  updateSession,
} from '@/lib/services/event-registration';
import { buildInvitePrefill, registerPublic, respondInvite } from '@/lib/services/event-rsvp';
import { rememberCookieValue } from '@/lib/events/tokens';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The guest side of Events on the demo store (D-075): the host's list and
 * bulk decisions, the "Needs notifying" queue, audiences with personal links,
 * export/import, registration settings and sessions, the personal link's
 * RSVP and the public page's viewer, and check-in. Fictional people only.
 */

let h: Harness;
let owner: EventOwner;
const ID = DEMO_EVENT_IDS;
const EVENT = ID.annualMeeting;

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
});

afterEach(async () => {
  await h.dispose();
});

async function event() {
  return (await h.store.get('events', owner.organizationId, EVENT))!;
}

async function statusOf(guestId: string, sessionId: string) {
  return (
    (
      await h.store.findOne('event_guest_sessions', owner.organizationId, {
        eq: { guest_id: guestId, session_id: sessionId },
      })
    )?.status ?? null
  );
}

describe('the host’s guest list', () => {
  it('lists every guest with per-session status, plus-ones linked to their host', async () => {
    const roster = await listGuests(h.store, owner.organizationId, EVENT);
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    const eli = roster.value.guests.find((g) => g.id === ID.guestEli)!;
    expect(eli.plusOneIds).toEqual([ID.guestEliPlusOne]);
    const rowan = roster.value.guests.find((g) => g.id === ID.guestEliPlusOne)!;
    expect(rowan).toMatchObject({ parentName: 'Eli Barrow', status: 'going' });
    expect(roster.value.counts).toMatchObject({ going: 4, pending: 1, invited: 1 });
  });

  it('approves the pending guest, records the note, and audits it', async () => {
    const result = await bulkGuests(h.store, owner, EVENT, {
      action: 'approve',
      guestIds: [ID.guestDana],
      note: 'Welcome back',
    });
    expect(result.ok && result.value).toMatchObject({ changed: 1, full: 0 });
    expect(await statusOf(ID.guestDana, ID.sessionReception)).toBe('going');
    const row = await h.store.findOne('event_guest_sessions', owner.organizationId, {
      eq: { guest_id: ID.guestDana, session_id: ID.sessionReception },
    });
    expect(row).toMatchObject({ decision_note: 'Welcome back', decided_by: owner.userId });
    const audits = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.guest_status_changed' },
    });
    expect(audits).toHaveLength(1);
    const detail = await getGuestDetail(h.store, owner.organizationId, EVENT, ID.guestDana);
    expect(detail.ok && detail.value.timeline.some((t) => t.kind === 'status')).toBe(true);
  });

  it('will not approve past capacity unless forced', async () => {
    await h.store.update('event_sessions', owner.organizationId, ID.sessionReception, {
      capacity: 4,
    });
    const refused = await bulkGuests(h.store, owner, EVENT, {
      action: 'approve',
      guestIds: [ID.guestDana],
    });
    expect(refused.ok && refused.value).toMatchObject({ changed: 0, full: 1 });
    expect(await statusOf(ID.guestDana, ID.sessionReception)).toBe('pending');
    const forced = await bulkGuests(h.store, owner, EVENT, {
      action: 'going',
      guestIds: [ID.guestDana],
      sessionId: ID.sessionReception,
      force: true,
    });
    expect(forced.ok && forced.value.changed).toBe(1);
  });

  it('adds guests deduplicated on email, tags, rotates links and removes', async () => {
    const added = await addGuests(h.store, owner, EVENT, {
      people: [
        {
          email: 'avery.quill@example.com',
          first_name: null,
          last_name: null,
          company: null,
          title: null,
          phone: null,
        },
        {
          email: 'new.person@example.com',
          first_name: 'New',
          last_name: 'Person',
          company: 'Sample LLC',
          title: null,
          phone: null,
        },
      ],
      sessionIds: [ID.sessionReception],
      status: 'invited',
      source: 'host',
      tags: ['VIP'],
    });
    expect(added.ok && added.value).toMatchObject({ overCapacity: 0 });
    expect(added.ok && added.value.added).toHaveLength(1);
    expect(added.ok && added.value.merged).toEqual([ID.guestAvery]);
    const avery = await h.store.get('event_guests', owner.organizationId, ID.guestAvery);
    expect(avery?.tags).toEqual(['LP', 'VIP']);

    const tagged = await bulkGuests(h.store, owner, EVENT, {
      action: 'add_tag',
      guestIds: [ID.guestCarlos],
      tag: 'Speaker',
    });
    expect(tagged.ok && tagged.value.changed).toBe(1);

    const ev = await event();
    const before = inviteToken({
      organizationId: ev.organization_id,
      eventId: ev.id,
      guestId: ID.guestCarlos,
      tokenVersion: 1,
    });
    await bulkGuests(h.store, owner, EVENT, { action: 'rotate_links', guestIds: [ID.guestCarlos] });
    const carlos = (await h.store.get('event_guests', owner.organizationId, ID.guestCarlos))!;
    expect(carlos.token_version).toBe(2);
    expect(
      verifyGuestToken(RSVP_TOKEN_PURPOSE, before, {
        organizationId: ev.organization_id,
        eventId: ev.id,
        guestId: carlos.id,
        tokenVersion: 2,
      }),
    ).toBe(false);

    const removed = await bulkGuests(h.store, owner, EVENT, {
      action: 'remove',
      guestIds: [ID.guestEli],
    });
    expect(removed.ok && removed.value.removed).toBe(1);
    expect(await h.store.get('event_guests', owner.organizationId, ID.guestEliPlusOne)).toBeNull();
  });

  it('edits a guest and refuses a duplicate email', async () => {
    const ok1 = await updateGuest(h.store, owner, EVENT, ID.guestCarlos, {
      host_note: 'Seat near the front',
      tags: ['Founder', 'Speaker'],
    });
    expect(ok1.ok && ok1.value).toMatchObject({
      note: 'Seat near the front',
      tags: ['Founder', 'Speaker'],
    });
    const clash = await updateGuest(h.store, owner, EVENT, ID.guestCarlos, {
      email: 'avery.quill@example.com',
    });
    expect(!clash.ok && clash.error.code).toBe('conflict');
  });
});

describe('needs notifying', () => {
  it('groups status changes nobody has told the guest about, and markNotified clears them', async () => {
    expect(notifyKindFor('going', 'waitlist')).toBe('promoted');
    expect(notifyKindFor('going', undefined)).toBe('confirmed');
    expect(notifyKindFor('maybe', undefined)).toBeNull();
    const queue = await needsNotifying(h.store, owner.organizationId, EVENT);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    const kinds = Object.fromEntries(queue.value.map((g) => [g.kind, g.items.length]));
    // Avery ×2, Bianca, Eli are Going; Dana pending. Plus-ones hear through their host.
    expect(kinds).toEqual({ confirmed: 4, pending: 1 });
    const dana = queue.value.find((g) => g.kind === 'pending')!.items;
    const marked = await markNotified(h.store, owner.organizationId, EVENT, dana);
    expect(marked.ok && marked.value.updated).toBe(1);
    // A pair whose status changed since is left in the queue.
    const stale = await markNotified(h.store, owner.organizationId, EVENT, [
      { guestId: ID.guestBianca, sessionId: ID.sessionReception, status: 'waitlist' },
    ]);
    expect(stale.ok && stale.value.updated).toBe(0);
    const after = await needsNotifying(h.store, owner.organizationId, EVENT);
    expect(after.ok && after.value.map((g) => g.kind)).toEqual(['confirmed']);
  });

  it('resolves campaign audiences with each guest’s personal link', async () => {
    const audience = await resolveAudience(h.store, owner.organizationId, EVENT, {
      kind: 'status',
      statuses: ['going'],
      sessionId: ID.sessionReception,
    });
    expect(audience.ok).toBe(true);
    if (!audience.ok) return;
    expect(audience.value.map((m) => m.email).sort()).toEqual([
      'avery.quill@example.com',
      'bianca.moreau@example.com',
      'eli.barrow@example.com',
    ]);
    const ev = await event();
    const avery = audience.value.find((m) => m.guestId === ID.guestAvery)!;
    expect(avery.rsvpPath).toMatch(new RegExp(`^/e/${DEMO_EVENT_SLUGS.annualMeeting}/i/`));
    const token = avery.rsvpPath.split('/i/')[1]!;
    expect(
      verifyGuestToken(RSVP_TOKEN_PURPOSE, token, {
        organizationId: ev.organization_id,
        eventId: ev.id,
        guestId: ID.guestAvery,
        tokenVersion: 1,
      }),
    ).toBe(true);
    const lps = await resolveAudience(h.store, owner.organizationId, EVENT, {
      kind: 'tag',
      tag: 'lp',
    });
    expect(lps.ok && lps.value).toHaveLength(4);
  });
});

describe('export and import', () => {
  it('exports with an audit row, filtered or whole, and a headcount', async () => {
    const all = await exportGuests(h.store, owner, EVENT);
    expect(all.ok && all.value.rows).toBe(6);
    expect(all.ok && all.value.csv).toContain('Evening Reception');
    const going = await exportGuests(h.store, owner, EVENT, {
      filter: { tab: 'going', sessionId: null, tag: null, source: null, referral: null, q: '' },
    });
    expect(going.ok && going.value.rows).toBe(4);
    const heads = await exportGuests(h.store, owner, EVENT, { kind: 'headcount' });
    expect(
      heads.ok && heads.value.headcounts?.find((c) => c.name === 'Evening Reception')?.going,
    ).toBe(4);
    const audits = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.guests_exported' },
    });
    expect(audits).toHaveLength(3);
  });

  it('previews an import, then commits it deduplicated', async () => {
    const csv =
      'Name,Email\nPat Placeholder,pat@example.com\nAvery Again,AVERY.QUILL@example.com\nNobody,\n';
    const preview = await importGuests(h.store, owner, EVENT, {
      csv,
      sessionIds: [],
      tags: ['Press'],
      status: 'invited',
      commit: false,
    });
    expect(preview.ok && preview.value).toMatchObject({
      people: 2,
      existing: 1,
      invalidLines: [4],
      committed: null,
    });
    const committed = await importGuests(h.store, owner, EVENT, {
      csv,
      sessionIds: [ID.sessionMeeting],
      tags: ['Press'],
      status: 'invited',
      commit: true,
    });
    expect(committed.ok && committed.value.committed?.added).toHaveLength(1);
    const pat = await h.store.findOne('event_guests', owner.organizationId, {
      eq: { email: 'pat@example.com' },
    });
    expect(pat).toMatchObject({
      first_name: 'Pat',
      last_name: 'Placeholder',
      source: 'import',
      tags: ['Press'],
    });
  });
});

describe('registration settings and sessions', () => {
  it('saves access and questions, keeping removed questions for exports', async () => {
    const view = await getRegistration(h.store, owner.organizationId, EVENT);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const keep = view.value.questions.filter((q) => q.type === 'dietary');
    const saved = await updateRegistration(h.store, owner, EVENT, {
      access: 'approval',
      questions: keep,
    });
    expect(saved.ok && saved.value.access).toBe('approval');
    const removed = saved.ok
      ? saved.value.questions.find((q) => q.type === 'long_text')
      : undefined;
    expect(removed?.removed_at).toBeTruthy();
    const bad = await updateRegistration(h.store, owner, EVENT, { capacity: -1 });
    expect(bad.ok).toBe(false);
    const unknownKey = await updateRegistration(h.store, owner, EVENT, {
      access: 'open',
      secret: true,
    });
    expect(unknownKey.ok).toBe(false);
  });

  it('bumps the ICS sequence when a session moves, and keeps the event spanning its sessions', async () => {
    const before = await event();
    const moved = await updateSession(h.store, owner, EVENT, ID.sessionReception, {
      starts_at: '2031-01-26T01:00:00.000Z',
      ends_at: '2031-01-26T04:00:00.000Z',
    });
    expect(moved.ok && moved.value).toMatchObject({ scheduleChanged: true, goingCount: 4 });
    const after = await event();
    expect(after.schedule_version).toBe(before.schedule_version + 1);
    expect(after.ends_at).toBe('2031-01-26T04:00:00.000Z');
    const renamed = await updateSession(h.store, owner, EVENT, ID.sessionReception, {
      name: 'Reception',
    });
    expect(renamed.ok && renamed.value.scheduleChanged).toBe(false);
    const backwards = await updateSession(h.store, owner, EVENT, ID.sessionReception, {
      ends_at: '2020-01-01T00:00:00.000Z',
    });
    expect(backwards.ok).toBe(false);
  });

  it('adds sessions and removes one only when confirmed, never the last', async () => {
    const added = await addSession(h.store, owner, ID.puttingNight, { name: 'Short game clinic' });
    expect(added.ok).toBe(true);
    const refused = await removeSession(h.store, owner, EVENT, ID.sessionReception);
    expect(!refused.ok && refused.error.code).toBe('conflict');
    const done = await removeSession(h.store, owner, EVENT, ID.sessionReception, { confirm: true });
    expect(done.ok).toBe(true);
    const last = await removeSession(h.store, owner, EVENT, ID.sessionMeeting, { confirm: true });
    expect(!last.ok && last.error.message).toMatch(/at least one session/);
  });
});

describe('personal links and the public page', () => {
  it('lets an invited guest RSVP with a plus-one, then shows them as going', async () => {
    const ev = await event();
    const resolved = await resolvePublicEvent(h.store, ev.slug);
    expect(resolved.kind).toBe('event');
    if (resolved.kind !== 'event') return;
    const token = inviteToken({
      organizationId: ev.organization_id,
      eventId: ev.id,
      guestId: ID.guestCarlos,
      tokenVersion: 1,
    });
    const carlos = (await resolveInvite(h.store, ev, token))!;
    expect(carlos.guest.id).toBe(ID.guestCarlos);
    const prefill = await buildInvitePrefill(h.store, ev, resolved.sessions, carlos);
    // Invite-only: only the session he was invited to.
    expect(prefill.respondable).toEqual([ID.sessionReception]);
    const result = await respondInvite(h.store, ev, resolved.sessions, carlos, {
      responses: { [ID.sessionReception]: 'going' },
      answers: {},
      plusOnes: [
        {
          firstName: 'Jo',
          lastName: 'Example',
          answers: { '00000000-0000-4000-8000-0000e7e00401': ['Vegan'] },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome.sessions[ID.sessionReception]).toBe('going');
    expect(result.value.ticketPath).toMatch(/\/ticket$/);
    // The remembered cookie makes the public page show him as going.
    const remembered = await resolveRemembered(h.store, ev, result.value.rememberCookie);
    const page = await buildPublicPage(h.store, resolved, remembered);
    expect(page?.viewer).toMatchObject({ kind: 'guest', going: true, firstName: 'Carlos' });
    const ticket = await buildTicket(h.store, ev, resolved.sessions, carlos.guest, { full: true });
    expect(ticket.people.map((p) => p.name)).toEqual(['Carlos Ferro', 'Jo Example']);
    expect(ticket.people.every((p) => p.checkinPath?.startsWith(`/e/${ev.slug}/c/`))).toBe(true);
    // A session he was not invited to is refused.
    const sneaky = await respondInvite(h.store, ev, resolved.sessions, carlos, {
      responses: { [ID.sessionMeeting]: 'going' },
      answers: {},
    });
    expect(!sneaky.ok && sneaky.error.code).toBe('invalid_input');
  });

  it('a rotated or forged token opens nothing; a cookie with an old version is ignored', async () => {
    const ev = await event();
    const token = inviteToken({
      organizationId: ev.organization_id,
      eventId: ev.id,
      guestId: ID.guestCarlos,
      tokenVersion: 1,
    });
    await bulkGuests(h.store, owner, EVENT, { action: 'rotate_links', guestIds: [ID.guestCarlos] });
    expect(await resolveInvite(h.store, ev, token)).toBeNull();
    expect(await resolveInvite(h.store, ev, 'x'.repeat(43) + '.' + 'y'.repeat(22))).toBeNull();
    const oldCookie = rememberCookieValue({
      eventId: ev.id,
      guestId: ID.guestCarlos,
      tokenVersion: 1,
    });
    expect(await resolveRemembered(h.store, ev, oldCookie)).toBeNull();
  });

  it('keeps invite-only pages closed to the public form except “Request an invite”', async () => {
    const ev = await event();
    const sessions = await h.store.list('event_sessions', owner.organizationId, {
      eq: { event_id: ev.id },
    });
    const base = {
      formToken: 'x',
      firstName: 'Quinn',
      lastName: 'Sample',
      email: 'quinn@example.com',
      sessions: [ID.sessionMeeting],
      answers: {},
      plusOnes: [],
      showOnWall: false,
    };
    const refused = await registerPublic(
      h.store,
      ev,
      sessions,
      { ...base, request: false },
      { ipHash: null },
    );
    expect(!refused.ok && refused.error.code).toBe('forbidden');
    const request = await registerPublic(
      h.store,
      ev,
      sessions,
      { ...base, request: true },
      { ipHash: null },
    );
    expect(request.ok && request.value.outcome.sessions[ID.sessionMeeting]).toBe('pending');
    const again = await registerPublic(
      h.store,
      ev,
      sessions,
      { ...base, request: true },
      { ipHash: null },
    );
    expect(!again.ok && again.error.message).toMatch(/already registered/i);
  });

  it('only shows published, non-private events, and 301s old slugs', async () => {
    expect((await resolvePublicEvent(h.store, DEMO_EVENT_SLUGS.puttingNight)).kind).toBe(
      'not_found',
    );
    expect((await resolvePublicEvent(h.store, 'Not A Slug')).kind).toBe('not_found');
    await h.store.insert('event_slug_aliases', {
      slug: 'old-annual-meeting',
      organization_id: owner.organizationId,
      event_id: EVENT,
      created_at: new Date().toISOString(),
    });
    expect(await resolvePublicEvent(h.store, 'old-annual-meeting')).toEqual({
      kind: 'redirect',
      slug: DEMO_EVENT_SLUGS.annualMeeting,
    });
    await h.store.update('events', owner.organizationId, EVENT, { visibility: 'private' });
    expect((await resolvePublicEvent(h.store, DEMO_EVENT_SLUGS.annualMeeting)).kind).toBe(
      'not_found',
    );
  });

  it('gates the venue address by status on the server', async () => {
    const resolved = await resolvePublicEvent(h.store, DEMO_EVENT_SLUGS.annualMeeting);
    if (resolved.kind !== 'event') throw new Error('no event');
    const publicPage = await buildPublicPage(h.store, resolved, null);
    expect(publicPage?.facts.venue).toMatchObject({
      name: 'The Lantern Hall',
      address: null,
      revealed: false,
    });
    const ev = resolved.event;
    const token = inviteToken({
      organizationId: ev.organization_id,
      eventId: ev.id,
      guestId: ID.guestAvery,
      tokenVersion: 1,
    });
    const avery = await resolveInvite(h.store, ev, token);
    const guestPage = await buildPublicPage(h.store, resolved, avery);
    expect(guestPage?.facts.venue?.address).toBe('100 Example Avenue, Springfield');
    // The public page's registration never lists emails or other guests.
    expect(JSON.stringify(publicPage)).not.toContain('@example.com');
  });
});

describe('check-in', () => {
  const actor: CheckinActor = {
    kind: 'staff',
    grantId: DEMO_EVENT_IDS.editorJordan,
    name: 'Door team',
  };

  it('checks in once; a second scan is amber with who and when; undo works', async () => {
    const ev = await event();
    const first = await checkInGuest(h.store, ev, actor, {
      guestId: ID.guestAvery,
      sessionId: ID.sessionReception,
    });
    expect(first.ok && first.value.state).toBe('checked_in');
    const second = await checkInGuest(h.store, ev, actor, {
      guestId: ID.guestAvery,
      sessionId: ID.sessionReception,
    });
    expect(second.ok && second.value).toMatchObject({
      state: 'already',
      by: 'Jordan – Example Partners',
    });
    const wrong = await checkInGuest(h.store, ev, actor, {
      guestId: ID.guestCarlos,
      sessionId: ID.sessionReception,
    });
    expect(wrong.ok && wrong.value.state).toBe('not_on_list');
    const undone = await checkInGuest(h.store, ev, actor, {
      guestId: ID.guestAvery,
      sessionId: ID.sessionReception,
      undo: true,
    });
    expect(undone.ok && undone.value.state).toBe('undone');
    const list = await doorList(h.store, owner.organizationId, EVENT);
    expect(list.ok && list.value.sessions.find((s) => s.id === ID.sessionReception)).toMatchObject({
      going: 4,
      checkedIn: 0,
    });
    expect(JSON.stringify(list.ok && list.value)).not.toContain('@example.com');
  });

  it('adds a walk-in as Going and checked in, even when full', async () => {
    await h.store.update('event_sessions', owner.organizationId, ID.sessionReception, {
      capacity: 4,
    });
    const ev = await event();
    const walk = await addWalkIn(h.store, ev, actor, {
      firstName: 'Morgan',
      lastName: 'Walker',
      email: null,
      company: 'Example Studio',
      sessionId: ID.sessionReception,
    });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    const row = await h.store.findOne('event_guest_sessions', owner.organizationId, {
      eq: { guest_id: walk.value.guestId, session_id: ID.sessionReception },
    });
    expect(row).toMatchObject({
      status: 'going',
      checked_in_by: `g:${DEMO_EVENT_IDS.editorJordan}`,
    });
    expect(row?.checked_in_at).toBeTruthy();
  });

  it('only calls a session live within its window; the door list defaults to the next one', () => {
    const sessions = [
      { id: 'a', starts_at: '2030-01-25T19:00:00.000Z', ends_at: '2030-01-25T23:00:00.000Z' },
      { id: 'b', starts_at: '2030-01-26T00:00:00.000Z', ends_at: '2030-01-26T03:00:00.000Z' },
    ];
    const weekBefore = new Date('2030-01-18T19:00:00.000Z');
    expect(liveSession(sessions, weekBefore)).toBeNull();
    expect(currentSession(sessions, weekBefore)).toBe('a');
    expect(liveSession(sessions, new Date('2030-01-25T17:30:00.000Z'))).toBe('a');
    expect(liveSession(sessions, new Date('2030-01-25T22:30:00.000Z'))).toBe('a');
    expect(liveSession(sessions, new Date('2030-01-26T01:00:00.000Z'))).toBe('b');
    expect(liveSession(sessions, new Date('2030-01-26T02:59:00.000Z'))).toBe('b');
  });
});
