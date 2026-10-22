import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/auth/session';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import { PUBLIC_VIEWER, type EventViewer } from '@/lib/events/contracts';
import { headcounts } from '@/lib/events/csv';
import { inTab, statusAudienceMatch, tabCounts } from '@/lib/events/guest-list';
import { buildIcs } from '@/lib/events/ics';
import { formToken } from '@/lib/events/public-gate';
import type { RegistrationQuestion } from '@/lib/events/questions';
import { parseEventDoc } from '@/lib/events/schema';
import { audienceGuestIds } from '@/lib/events/tab-view';
import { inviteToken } from '@/lib/events/tokens';
import { filterDocForViewer } from '@/lib/events/visibility';
import { scrubMp4, scrubWebm } from '@/lib/events/video-meta';
import { createEditorLink } from '@/lib/services/event-editors';
import { messageCopy } from '@/lib/events/message-copy';
import { reviewCampaign, reviewIssues } from '@/lib/services/campaigns';
import { eventLinkCheck } from '@/lib/services/event-campaign-links';
import { draftEventMessage, eventMessagesView } from '@/lib/services/event-comms';
import { buildTicket } from '@/lib/services/event-public';
import { bulkGuests, guestCounts, toListItems } from '@/lib/services/event-guests';
import { removeSession, updateSession } from '@/lib/services/event-registration';
import { SELF_REGISTRATIONS_PER_HOUR } from '@/lib/services/event-rsvp';
import { createEvent, duplicateEvent, type EventOwner } from '@/lib/services/events';
import type {
  Campaign,
  CampaignRecipient,
  EventGuest,
  EventGuestSession,
} from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The fixes from the pre-deploy security, design and guest-flow reviews
 * (D-075 fix-up). Each test here fails on the code before the fix-up.
 * Fictional data; no network.
 */

let h: Harness;
let owner: EventOwner;
let signedIn: () => Result<AuthContext>;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
  getAuthContext: async () => null,
}));

const rsvpRoute = await import('@/app/api/e/[slug]/rsvp/route');
const respondRoute = await import('@/app/api/e/[slug]/i/[token]/respond/route');
const claimRoute = await import('@/app/api/e/edit/session/route');

const EVENT = DEMO_EVENT_IDS.annualMeeting;
const SLUG = DEMO_EVENT_SLUGS.annualMeeting;
const MEETING = DEMO_EVENT_IDS.sessionMeeting;
const RECEPTION = DEMO_EVENT_IDS.sessionReception;
const ORIGIN = 'http://localhost:3000';

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
  signedIn = () => ok(h.auth);
});

afterEach(async () => {
  await h.dispose();
  vi.unstubAllEnvs();
});

let ip = 0;
function post(path: string, body: unknown, origin = ORIGIN) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin,
      'content-type': 'application/json',
      // A fresh address per request, so the per-address brake stays out of the way.
      'x-forwarded-for': `198.51.100.${(++ip % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

function requestBody(email: string, sessions = [MEETING, RECEPTION]) {
  return {
    formToken: formToken(EVENT, Date.now() - 5_000),
    firstName: 'Riley',
    lastName: 'Stranger',
    email,
    sessions,
    answers: {},
    plusOnes: [],
    showOnWall: false,
    request: true,
  };
}

const slugParams = { params: Promise.resolve({ slug: SLUG }) };

async function guestByEmail(email: string): Promise<EventGuest> {
  const g = await h.store.findOne('event_guests', h.auth.organizationId, {
    eq: { event_id: EVENT, email },
  });
  if (!g) throw new Error('no guest');
  return g;
}

async function statusesOf(guestId: string): Promise<Record<string, string>> {
  const rows = await h.store.list('event_guest_sessions', h.auth.organizationId, {
    eq: { event_id: EVENT, guest_id: guestId },
  });
  return Object.fromEntries(rows.map((r) => [r.session_id, r.status]));
}

describe('invite-only "Request an invite" cannot skip the host (critical)', () => {
  it('pending → Maybe → Going and pending → Can’t go → Going both stay Pending over HTTP', async () => {
    const res = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, requestBody('riley.stranger@example.com')),
      slugParams,
    );
    expect(res.status).toBe(200);
    const stranger = await guestByEmail('riley.stranger@example.com');
    // Their own personal link (the remembered page hands it to them).
    const token = inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: stranger.id,
      tokenVersion: stranger.token_version,
    });
    const respond = (responses: Record<string, string>) =>
      respondRoute.POST(post(`/api/e/${SLUG}/i/${token}/respond`, { responses, answers: {} }), {
        params: Promise.resolve({ slug: SLUG, token }),
      });

    expect((await respond({ [MEETING]: 'maybe', [RECEPTION]: 'maybe' })).status).toBe(200);
    const going = await respond({ [MEETING]: 'going', [RECEPTION]: 'going' });
    expect((await going.json()).outcome.sessions).toEqual({
      [MEETING]: 'pending',
      [RECEPTION]: 'pending',
    });
    await respond({ [MEETING]: 'not_going' });
    await respond({ [MEETING]: 'going' });
    expect(await statusesOf(stranger.id)).toEqual({ [MEETING]: 'pending', [RECEPTION]: 'pending' });

    // And the address (reveal "registered") stays hidden on their ticket.
    const event = (await h.store.get('events', h.auth.organizationId, EVENT))!;
    const sessions = await h.store.list('event_sessions', h.auth.organizationId, {
      eq: { event_id: EVENT },
    });
    const ticket = await buildTicket(h.store, event, sessions, stranger, { full: true });
    expect(ticket.venue).toMatchObject({ address: null, revealed: false });
    expect(JSON.stringify(ticket)).not.toContain('100 Example Avenue');
  });
});

describe('the public form is not a guest-list oracle (security medium)', () => {
  it('answers a known email exactly like a new request, writes nothing, and opens nothing', async () => {
    const fresh = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, requestBody('newcomer@example.com')),
      slugParams,
    );
    // Avery is already on the demo list.
    const avery = (await h.store.get(
      'event_guests',
      h.auth.organizationId,
      DEMO_EVENT_IDS.guestAvery,
    ))!;
    const known = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, requestBody(avery.email!)),
      slugParams,
    );
    expect(known.status).toBe(fresh.status);
    expect(await known.json()).toEqual(await fresh.json());
    expect(known.headers.get('set-cookie')).toMatch(/tiptop_ev_rsvp=/);
    // Avery's own rows are untouched; there is still one Avery.
    const averys = await h.store.list('event_guests', h.auth.organizationId, {
      eq: { event_id: EVENT, email: avery.email! },
    });
    expect(averys).toHaveLength(1);
    const audit = await h.store.list('audit_events', h.auth.organizationId, {
      eq: { action: 'event.rsvp_duplicate' },
    });
    expect(audit).toHaveLength(1);
  });

  it('caps new self-registrations per event per hour, whatever address they come from', async () => {
    const now = new Date().toISOString();
    const rows: EventGuest[] = Array.from({ length: SELF_REGISTRATIONS_PER_HOUR }, (_, i) => ({
      ...(avery0 as EventGuest),
      id: `00000000-0000-4000-8000-${(0xb000 + i).toString(16).padStart(12, '0')}`,
      email: `flood${i}@example.com`,
      source: 'request',
      created_at: now,
      updated_at: now,
    }));
    await h.store.insertMany('event_guests', rows);
    const res = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, requestBody('one-more@example.com')),
      slugParams,
    );
    expect(res.status).toBe(429);
  });
});

// A template guest row for the flood test (filled in beforeEach of that block's run).
let avery0: EventGuest | null = null;
beforeEach(async () => {
  avery0 = await h.store.get('event_guests', h.auth.organizationId, DEMO_EVENT_IDS.guestAvery);
});

describe('outside-editor claim is same-origin only (security low)', () => {
  it('refuses a cross-site POST with the same 404, even for a real link', async () => {
    const issued = await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan – Example Partners',
      role: 'editor',
    });
    if (!issued.ok) throw new Error(issued.error.message);
    const token = issued.value.path.split('#k=')[1]!;
    const cross = await claimRoute.POST(
      post('/api/e/edit/session', { token, claim: false }, 'https://evil.example'),
    );
    expect(cross.status).toBe(404);
    const same = await claimRoute.POST(post('/api/e/edit/session', { token, claim: false }));
    expect(same.status).toBe(200);
  });
});

describe('an old slug only redirects a real personal link (security low)', () => {
  it('a forged token on an old address is a 404, not a redirect to the new slug', async () => {
    await h.store.insert('event_slug_aliases', {
      id: '00000000-0000-4000-8000-00000000a11a',
      organization_id: h.auth.organizationId,
      event_id: EVENT,
      slug: 'harborview-old-name',
      created_at: new Date().toISOString(),
    } as never);
    const invitePage = await import('@/app/e/[slug]/i/[token]/page');
    const forged = `${'A'.repeat(43)}.${'b'.repeat(22)}`;
    await expect(
      invitePage.default({
        params: Promise.resolve({ slug: 'harborview-old-name', token: forged }),
      }),
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    const real = inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestAvery,
      tokenVersion: 1,
    });
    await expect(
      invitePage.default({ params: Promise.resolve({ slug: 'harborview-old-name', token: real }) }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe('Pending and Waitlist see per-session requests (guests high)', () => {
  const g = (id: string): EventGuest =>
    ({ ...(avery0 as EventGuest), id, email: `${id.slice(-4)}@example.com` }) as EventGuest;
  const row = (guest: string, session: string, status: EventGuestSession['status']) =>
    ({
      guest_id: guest,
      session_id: session,
      organization_id: h.auth.organizationId,
      event_id: EVENT,
      status,
      requested_at: null,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      claim_expires_at: null,
      checked_in_at: null,
      checked_in_by: null,
      created_at: '2030-01-01T00:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
    }) as EventGuestSession;

  it('a Going Meeting with a pending/waitlisted Reception shows under Pending/Waitlist', () => {
    const a = g('00000000-0000-4000-8000-00000000c0a1');
    const b = g('00000000-0000-4000-8000-00000000c0a2');
    const rows = [
      row(a.id, MEETING, 'going'),
      row(a.id, RECEPTION, 'pending'),
      row(b.id, MEETING, 'going'),
      row(b.id, RECEPTION, 'waitlist'),
    ];
    const items = toListItems([a, b], rows);
    expect(items.map((i) => inTab(i, 'pending'))).toEqual([true, false]);
    expect(items.map((i) => inTab(i, 'waitlist'))).toEqual([false, true]);
    expect(items.map((i) => inTab(i, 'going'))).toEqual([true, true]);
    expect(tabCounts(items)).toMatchObject({ pending: 1, waitlist: 1, going: 2 });
    // Audiences: "Pending" reaches a, "Waitlist" reaches b; Can't go stays guest-level.
    expect(statusAudienceMatch(['pending'], ['going', 'pending'])).toBe(true);
    expect(statusAudienceMatch(['not_going'], ['going', 'not_going'])).toBe(false);
    expect(audienceGuestIds([a, b], rows, { kind: 'status', statuses: ['waitlist'] })).toEqual([
      b.id,
    ]);
  });

  it('the library card and Today counts include them', async () => {
    const before = (await guestCounts(h.store, h.auth.organizationId, [EVENT]))[EVENT]!;
    // Give a Going guest a pending Reception request.
    const rows = await h.store.list('event_guest_sessions', h.auth.organizationId, {
      eq: { event_id: EVENT },
    });
    const goingMeeting = rows.find(
      (r) =>
        r.session_id === MEETING &&
        r.status === 'going' &&
        rows.some(
          (x) => x.guest_id === r.guest_id && x.session_id === RECEPTION && x.status !== 'pending',
        ),
    );
    expect(goingMeeting).toBeDefined();
    if (!goingMeeting) return;
    await h.store.updateWhere(
      'event_guest_sessions',
      h.auth.organizationId,
      { eq: { guest_id: goingMeeting.guest_id, session_id: RECEPTION } },
      { status: 'pending' },
    );
    const after = (await guestCounts(h.store, h.auth.organizationId, [EVENT]))[EVENT]!;
    expect(after.pending).toBe(before.pending + 1);
    expect(after.going).toBe(before.going);
  });
});

describe('Duplicate keeps session-tied items and conditions (guests high)', () => {
  it('remaps agenda items and show-if conditions onto the copy’s sessions', async () => {
    const source = (await h.store.get('events', h.auth.organizationId, EVENT))!;
    const parsed = parseEventDoc(source.draft_doc);
    if (!parsed.ok) throw new Error('draft unreadable');
    const doc = parsed.value;
    const agenda = doc.sections.find((s) => s.type === 'agenda')!;
    (agenda.props as Record<string, unknown>).items = [
      { time: '1:00 PM', title: 'Meeting item', sessionId: MEETING },
      { time: '6:00 PM', title: 'Reception item', sessionId: RECEPTION },
      { time: '', title: 'Untied item' },
    ];
    const questions = [
      ...(source.questions as RegistrationQuestion[]),
      {
        id: '00000000-0000-4000-8000-0000000c0de1',
        type: 'yes_no',
        label: 'Staying for dinner?',
        help: null,
        required: false,
        options: [],
        session_id: null,
        ask_plus_ones: false,
        position: 9,
        removed_at: null,
        show_if: { kind: 'session', session_id: RECEPTION },
      },
    ] as RegistrationQuestion[];
    await h.store.update('events', h.auth.organizationId, EVENT, {
      draft_doc: doc as unknown as Record<string, unknown>,
      questions,
    });

    const copy = await duplicateEvent(h.store, owner, EVENT, { shiftDays: 364 });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const sessions = await h.store.list('event_sessions', h.auth.organizationId, {
      eq: { event_id: copy.value.id },
    });
    const ids = new Set(sessions.map((s) => s.id));
    const copyDoc = parseEventDoc(copy.value.draft_doc);
    if (!copyDoc.ok) throw new Error('copy unreadable');
    const items = (
      copyDoc.value.sections.find((s) => s.type === 'agenda')!.props as {
        items: { title: string; sessionId?: string | null }[];
      }
    ).items;
    expect(items.filter((i) => i.sessionId).every((i) => ids.has(i.sessionId!))).toBe(true);
    // A guest going to every session of the copy sees all three items.
    const everyone: EventViewer = {
      ...PUBLIC_VIEWER,
      kind: 'guest',
      registered: true,
      going: true,
      rsvp: Object.fromEntries(sessions.map((s) => [s.id, 'going'])),
    };
    const seen = filterDocForViewer(copyDoc.value, everyone, { visibleSessionIds: ids });
    const seenItems = (
      seen.sections.find((s) => s.type === 'agenda')!.props as {
        items: unknown[];
      }
    ).items;
    expect(seenItems).toHaveLength(3);
    const dinner = (copy.value.questions as RegistrationQuestion[]).find(
      (q) => q.label === 'Staying for dinner?',
    )!;
    expect(dinner.show_if?.kind === 'session' && ids.has(dinner.show_if.session_id)).toBe(true);
  });
});

describe('Removing a session clears conditions on it (guests low)', () => {
  it('a later questions save is not blocked by a dangling show-if', async () => {
    const source = (await h.store.get('events', h.auth.organizationId, EVENT))!;
    await h.store.update('events', h.auth.organizationId, EVENT, {
      questions: [
        ...(source.questions as RegistrationQuestion[]),
        {
          id: '00000000-0000-4000-8000-0000000c0de2',
          type: 'short_text',
          label: 'Table preference',
          help: null,
          required: false,
          options: [],
          session_id: null,
          ask_plus_ones: false,
          position: 9,
          removed_at: null,
          show_if: { kind: 'session', session_id: RECEPTION },
        },
      ] as RegistrationQuestion[],
    });
    const removed = await removeSession(h.store, owner, EVENT, RECEPTION, { confirm: true });
    expect(removed.ok).toBe(true);
    const after = (await h.store.get('events', h.auth.organizationId, EVENT))!;
    const q = (after.questions as RegistrationQuestion[]).find(
      (x) => x.label === 'Table preference',
    )!;
    expect(q.show_if ?? null).toBeNull();
    expect(q.removed_at).toBeNull();
  });
});

/* ------------------------------------------------------------------ video */

function box(type: string | Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(typeof type === 'string' ? new TextEncoder().encode(type) : type, 4);
  out.set(payload, 8);
  return out;
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);
const has = (bytes: Uint8Array, needle: Uint8Array) =>
  Buffer.from(bytes).indexOf(Buffer.from(needle)) !== -1;

describe('uploaded videos lose their location metadata (security medium)', () => {
  const XYZ = new Uint8Array([0xa9, 0x78, 0x79, 0x7a]); // ©xyz

  it('wipes moov/udta, trak/meta and XMP uuid boxes in place, sizes unchanged', () => {
    const udta = box('udta', box(XYZ, text('+30.27-097.74/')));
    const trak = box(
      'trak',
      cat(box('tkhd', new Uint8Array(12)), box('meta', text('Pixel 9 Pro'))),
    );
    const moov = box('moov', cat(box('mvhd', new Uint8Array(20)), trak, udta));
    const file = cat(
      box('ftyp', text('isomiso2')),
      moov,
      box('uuid', text('<x:xmpmeta>GPS 30.27</x:xmpmeta>')),
      box('mdat', text('frames')),
    );
    expect(has(file, XYZ)).toBe(true);
    const out = scrubMp4(file);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bytes.length).toBe(file.length);
    expect(has(out.bytes, XYZ)).toBe(false);
    expect(has(out.bytes, text('+30.27'))).toBe(false);
    expect(has(out.bytes, text('Pixel 9'))).toBe(false);
    expect(has(out.bytes, text('xmpmeta'))).toBe(false);
    // The media itself is untouched.
    expect(has(out.bytes, text('frames'))).toBe(true);
    expect(has(out.bytes, text('mvhd'))).toBe(true);
  });

  it('refuses an MP4 it cannot walk', () => {
    const broken = cat(
      box('ftyp', text('isomiso2')),
      new Uint8Array([0, 0, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76, 1, 2, 3]),
    );
    expect(scrubMp4(broken).ok).toBe(false);
  });

  it('voids WebM Tags (same length), and walks a live recording’s unknown-size cluster', () => {
    const el = (id: number[], payload: Uint8Array) =>
      cat(new Uint8Array(id), new Uint8Array([0x80 | payload.length]), payload);
    const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], text('webm')));
    const info = el([0x15, 0x49, 0xa9, 0x66], el([0x4d, 0x80], text('Recorder')));
    const block = el([0xa3], text('frame-data'));
    // Cluster with an unknown size (0x01FFFFFFFFFFFFFF).
    const cluster = cat(
      new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      block,
    );
    const tags = el([0x12, 0x54, 0xc3, 0x67], el([0x73, 0x73], text('LOCATION=30.27,-97.74')));
    const segment = cat(
      new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      info,
      cluster,
      tags,
    );
    const file = cat(header, segment);
    const out = scrubWebm(file);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bytes.length).toBe(file.length);
    expect(has(out.bytes, text('LOCATION'))).toBe(false);
    expect(has(out.bytes, text('frame-data'))).toBe(true);
  });
});

describe('an event message never sends dead personal links (guests medium)', () => {
  it('rotated links and an unpublished page stop the review and the send', async () => {
    const drafted = await draftEventMessage(
      h.store,
      owner,
      EVENT,
      { kind: 'invite', audience: { kind: 'status', statuses: ['invited'] } },
      { appUrl: 'https://copilot.example' },
    );
    if (!drafted.ok) throw new Error(drafted.error.message);
    const clean = await reviewCampaign(h.store, h.auth.organizationId, drafted.value.campaignId, {
      appUrl: 'https://copilot.example',
    });
    expect(clean.ok && clean.value.issues).toEqual([]);

    const recipients = await h.store.list('campaign_recipients', h.auth.organizationId, {
      eq: { campaign_id: drafted.value.campaignId },
    });
    const one = await guestByEmail(recipients[0]!.email);
    await bulkGuests(h.store, owner, EVENT, { action: 'rotate_links', guestIds: [one.id] });
    const stale = await reviewCampaign(h.store, h.auth.organizationId, drafted.value.campaignId, {
      appUrl: 'https://copilot.example',
    });
    expect(stale.ok && stale.value.issues.join(' ')).toMatch(/1 personal link is out of date/);

    await h.store.update('events', h.auth.organizationId, EVENT, { status: 'draft' });
    const offline = await reviewCampaign(h.store, h.auth.organizationId, drafted.value.campaignId, {
      appUrl: 'https://copilot.example',
    });
    expect(offline.ok && offline.value.issues.join(' ')).toMatch(/Publish the event page/);
  });
});

describe('no false "Draft an update" after pre-publish schedule edits (guests medium)', () => {
  it('counts only schedule changes after the first publish', async () => {
    const sessions = await h.store.list('event_sessions', h.auth.organizationId, {
      eq: { event_id: EVENT },
    });
    const view = async () =>
      eventMessagesView(
        h.store,
        h.auth.organizationId,
        (await h.store.get('events', h.auth.organizationId, EVENT))!,
        sessions,
      );
    await h.store.update('events', h.auth.organizationId, EVENT, {
      schedule_version: 2,
      published_schedule_version: 2,
    });
    expect((await view()).updateFor).toBeNull();
    await h.store.update('events', h.auth.organizationId, EVENT, { schedule_version: 3 });
    expect((await view()).updateFor).toBeGreaterThan(0);
  });
});

describe('status notices name their session and never go stale (guests medium)', () => {
  it('a notice about one session of a multi-session event says which one, and its time', () => {
    const copy = messageCopy(
      'notice',
      {
        title: 'Harborview Annual Meeting',
        when: 'Wed, Nov 25 · 1:00 PM – 9:00 PM CST',
        venueName: null,
        sessions: [
          { name: 'Annual Meeting', when: 'Wed, Nov 25 · 1:00 PM – 5:00 PM CST' },
          { name: 'Evening Reception', when: 'Wed, Nov 25 · 6:00 PM – 9:00 PM CST' },
        ],
        cancelMessage: null,
      },
      {
        notifyKind: 'waitlisted',
        session: { name: 'Evening Reception', when: 'Wed, Nov 25 · 6:00 PM – 9:00 PM CST' },
      },
    );
    expect(copy.subject).toContain('Evening Reception');
    expect(copy.body).toContain('Harborview Annual Meeting: Evening Reception');
  });

  it('a notice whose people changed status since the draft is refused at review', async () => {
    const avery = (await h.store.get(
      'event_guests',
      h.auth.organizationId,
      DEMO_EVENT_IDS.guestAvery,
    ))!;
    const campaign = {
      event_id: EVENT,
      event_kind: 'notice' as const,
      // Drafted when Avery was waitlisted for the Reception; she is Going now.
      event_meta: { notify: [{ guestId: avery.id, sessionId: RECEPTION, status: 'waitlist' }] },
    };
    const recipients = [
      { email: avery.email!, status: 'pending', merge: {} },
    ] as unknown as CampaignRecipient[];
    const check = await eventLinkCheck(h.store, h.auth.organizationId, campaign, recipients);
    expect(check).toMatchObject({ changedStatus: 1 });
    const review = reviewIssues(
      {
        ...(campaign as object),
        subject: 'About the reception',
        body_template: 'Hi {{first_name|there}}, about the reception.',
        attachments: [],
      } as unknown as Campaign,
      recipients,
      { eventLinks: check },
    );
    expect(review.issues.join(' ')).toMatch(/different status now/);
  });
});

describe('the AGM starter sets up what it promises (guests medium)', () => {
  it('plus-ones per session, a Reception dietary question, and an agenda tied to its sessions', async () => {
    const created = await createEvent(h.store, owner, {
      title: 'Lakeview Annual Meeting',
      timeZone: 'America/Chicago',
      starterId: 'agm-day-evening',
      startsAt: '2031-05-15T18:00:00.000Z',
      endsAt: '2031-05-16T02:00:00.000Z',
    });
    if (!created.ok) throw new Error(created.error.message);
    const ev = created.value;
    expect(ev.registration.plus_ones).toMatchObject({ max: 1, per_session: true });
    const sessions = await h.store.list('event_sessions', h.auth.organizationId, {
      eq: { event_id: ev.id },
    });
    const meeting = sessions.find((s) => s.name === 'Annual Meeting')!;
    const reception = sessions.find((s) => s.name === 'Evening Reception')!;
    const questions = ev.questions as RegistrationQuestion[];
    const dietary = questions.find((q) => q.type === 'dietary')!;
    expect(dietary).toMatchObject({ session_id: reception.id, ask_plus_ones: true });
    expect(questions.find((q) => q.label === 'Who would you like to meet?')?.session_id).toBeNull();
    const doc = parseEventDoc(ev.draft_doc);
    if (!doc.ok) throw new Error('draft unreadable');
    const items = (
      doc.value.sections.find((s) => s.type === 'agenda')!.props as {
        items: { column?: string; sessionId?: string }[];
      }
    ).items;
    expect(items.filter((i) => i.column === 'a').every((i) => i.sessionId === meeting.id)).toBe(
      true,
    );
    expect(items.filter((i) => i.column === 'b').every((i) => i.sessionId === reception.id)).toBe(
      true,
    );
  });
});

describe('small guest-flow corrections (guests low)', () => {
  it('a Maybe session is TENTATIVE in a personal calendar file', () => {
    const ics = buildIcs({
      eventTitle: 'Harborview Annual Meeting',
      sequence: 0,
      url: 'https://copilot.example/e/x/i/y',
      guestId: 'g1',
      cancelled: false,
      now: new Date('2030-01-01T00:00:00.000Z'),
      sessions: [
        {
          id: 's1',
          name: 'Meeting',
          description: null,
          startsAt: '2030-02-01T19:00:00.000Z',
          endsAt: '2030-02-01T23:00:00.000Z',
          location: null,
        },
        {
          id: 's2',
          name: 'Reception',
          description: null,
          startsAt: '2030-02-02T00:00:00.000Z',
          endsAt: '2030-02-02T03:00:00.000Z',
          location: null,
          tentative: true,
        },
      ],
    });
    expect(ics.match(/STATUS:CONFIRMED/g)).toHaveLength(1);
    expect(ics.match(/STATUS:TENTATIVE/g)).toHaveLength(1);
  });

  it('a Reception-only dietary answer is not counted in the Meeting’s caterer numbers', () => {
    const g = { ...(avery0 as EventGuest), answers: { q1: ['Vegan'] } };
    const counts = headcounts({
      guests: [g],
      rows: [
        { guest_id: g.id, session_id: MEETING, status: 'going', checked_in_at: null },
        { guest_id: g.id, session_id: RECEPTION, status: 'going', checked_in_at: null },
      ] as unknown as EventGuestSession[],
      sessions: [
        { id: MEETING, name: 'Meeting', position: 0, capacity: null },
        { id: RECEPTION, name: 'Reception', position: 1, capacity: null },
      ] as never,
      questions: [
        {
          id: 'q1',
          type: 'dietary',
          label: 'Dinner',
          help: null,
          required: false,
          options: [],
          session_id: RECEPTION,
          ask_plus_ones: true,
          position: 0,
          removed_at: null,
        },
      ],
    } as never);
    expect(counts.find((c) => c.sessionId === MEETING)!.dietary).toEqual({});
    expect(counts.find((c) => c.sessionId === RECEPTION)!.dietary).toEqual({ Vegan: 1 });
  });

  it('rotating a guest’s links also retires their plus-ones’ QR codes', async () => {
    const before = (await h.store.get(
      'event_guests',
      h.auth.organizationId,
      DEMO_EVENT_IDS.guestEliPlusOne,
    ))!;
    await bulkGuests(h.store, owner, EVENT, {
      action: 'rotate_links',
      guestIds: [DEMO_EVENT_IDS.guestEli],
    });
    const after = (await h.store.get(
      'event_guests',
      h.auth.organizationId,
      DEMO_EVENT_IDS.guestEliPlusOne,
    ))!;
    expect(after.token_version).toBe(before.token_version + 1);
  });

  it('raising a session’s capacity with auto-promote on seats the waitlist', async () => {
    const ev = (await h.store.get('events', h.auth.organizationId, EVENT))!;
    await h.store.update('events', h.auth.organizationId, EVENT, {
      registration: { ...ev.registration, auto_promote: true },
    });
    const going = await h.store.count('event_guest_sessions', h.auth.organizationId, {
      eq: { session_id: MEETING, status: 'going' },
    });
    await h.store.update('event_sessions', h.auth.organizationId, MEETING, { capacity: going });
    const stamp = new Date().toISOString();
    const waiter = { guest_id: '00000000-0000-4000-8000-000000000a17' };
    await h.store.insert('event_guests', {
      ...(avery0 as EventGuest),
      id: waiter.guest_id,
      email: 'waiting.guest@example.com',
      created_at: stamp,
      updated_at: stamp,
    });
    await h.store.insert('event_guest_sessions', {
      guest_id: waiter.guest_id,
      session_id: MEETING,
      organization_id: h.auth.organizationId,
      event_id: EVENT,
      status: 'waitlist',
      requested_at: stamp,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      claim_expires_at: null,
      checked_in_at: null,
      checked_in_by: null,
      created_at: stamp,
      updated_at: stamp,
    });
    const raised = await updateSession(h.store, owner, EVENT, MEETING, { capacity: going + 5 });
    expect(raised.ok && raised.value.promoted).toBe(1);
    const now = await h.store.findOne('event_guest_sessions', h.auth.organizationId, {
      eq: { guest_id: waiter.guest_id, session_id: MEETING },
    });
    expect(now?.status).toBe('going');
  });
});
