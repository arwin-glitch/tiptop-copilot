import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/auth/session';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import { formToken } from '@/lib/events/public-gate';
import { checkinToken, inviteToken } from '@/lib/events/tokens';
import { err, ok, type Result } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The WS4 routes end to end on the demo store (D-075): the public RSVP and
 * personal-link endpoints with their brakes, the QR check-in's staff check,
 * the staff claim, the calendar files, and the host's guest routes behind
 * the Copilot session. Fictional data; no network.
 */

let h: Harness;
let signedIn: () => Result<AuthContext>;
let sessionContext: () => AuthContext | null;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
  getAuthContext: async () => sessionContext(),
}));

const rsvpRoute = await import('@/app/api/e/[slug]/rsvp/route');
const respondRoute = await import('@/app/api/e/[slug]/i/[token]/respond/route');
const qrRoute = await import('@/app/api/e/[slug]/c/[token]/route');
const viewRoute = await import('@/app/api/e/[slug]/view/route');
const claimRoute = await import('@/app/api/e/checkin/session/route');
const doorRoute = await import('@/app/api/e/checkin/[eventId]/guests/route');
const icsRoute = await import('@/app/e/[slug]/calendar.ics/route');
const personalIcsRoute = await import('@/app/e/[slug]/i/[token]/calendar.ics/route');
const guestsRoute = await import('@/app/api/events/[id]/guests/route');
const exportRoute = await import('@/app/api/events/[id]/guests/export.csv/route');
const registrationRoute = await import('@/app/api/events/[id]/registration/route');
const linkRoute = await import('@/app/api/events/[id]/guests/[gid]/link/route');

const SLUG = DEMO_EVENT_SLUGS.annualMeeting;
const EVENT = DEMO_EVENT_IDS.annualMeeting;
const ORIGIN = 'http://localhost:3000';

beforeEach(async () => {
  h = await createHarness();
  signedIn = () => ok(h.auth);
  sessionContext = () => null;
});

afterEach(async () => {
  await h.dispose();
});

function post(path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function openEvent() {
  await h.store.update('events', h.auth.organizationId, EVENT, { access: 'open' });
}

function rsvpBody(over: Record<string, unknown> = {}) {
  return {
    formToken: formToken(EVENT, Date.now() - 5_000),
    firstName: 'Taylor',
    lastName: 'Example',
    email: 'taylor@example.com',
    sessions: [DEMO_EVENT_IDS.sessionMeeting],
    answers: {},
    plusOnes: [],
    showOnWall: false,
    ...over,
  };
}

const slugParams = (slug: string = SLUG) => ({ params: Promise.resolve({ slug }) });

describe('POST /api/e/<slug>/rsvp', () => {
  it('registers, answers with the outcome only, and remembers the browser on the event’s path', async () => {
    await openEvent();
    const res = await rsvpRoute.POST(post(`/api/e/${SLUG}/rsvp`, rsvpBody()), slugParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      outcome: { sessions: { [DEMO_EVENT_IDS.sessionMeeting]: 'going' } },
    });
    expect(json.ticketPath).toMatch(new RegExp(`^/e/${SLUG}/i/.+/ticket$`));
    expect(JSON.stringify(json)).not.toContain('avery');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/tiptop_ev_rsvp=/);
    expect(cookie).toMatch(new RegExp(`Path=/e/${SLUG}`, 'i'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses another origin, the honeypot, a too-fast form, unknown keys and an invite-only page', async () => {
    const cross = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody(), { origin: 'https://evil.example' }),
      slugParams(),
    );
    expect(cross.status).toBe(403);
    await openEvent();
    const bot = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ website: 'spam' })),
      slugParams(),
    );
    expect(bot.status).toBe(400);
    const fast = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ formToken: formToken(EVENT) })),
      slugParams(),
    );
    expect((await fast.json()).error.message).toMatch(/quick/);
    const extra = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ isAdmin: true })),
      slugParams(),
    );
    expect(extra.status).toBe(400);
    await h.store.update('events', h.auth.organizationId, EVENT, { access: 'invite_only' });
    const closed = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ email: 'other@example.com' })),
      slugParams(),
    );
    expect(closed.status).toBe(403);
  });

  it('answers a known email neutrally, and brakes repeat senders', async () => {
    await openEvent();
    const dupe = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ email: 'avery.quill@example.com' })),
      slugParams(),
    );
    expect(dupe.status).toBe(409);
    const body = await dupe.json();
    expect(body.error.message).toMatch(/already registered/i);
    expect(JSON.stringify(body)).not.toMatch(/\/i\//);
    for (let i = 0; i < 5; i++) {
      await rsvpRoute.POST(
        post(`/api/e/${SLUG}/rsvp`, rsvpBody({ email: `r${i}@example.com` }), {
          origin: ORIGIN,
          'cf-connecting-ip': '198.51.100.9',
        }),
        slugParams(),
      );
    }
    const limited = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, rsvpBody({ email: 'r9@example.com' }), {
        origin: ORIGIN,
        'cf-connecting-ip': '198.51.100.9',
      }),
      slugParams(),
    );
    expect(limited.status).toBe(429);
  });

  it('is a plain 404 for a draft or unknown event', async () => {
    const res = await rsvpRoute.POST(
      post(`/api/e/${DEMO_EVENT_SLUGS.puttingNight}/rsvp`, rsvpBody()),
      slugParams(DEMO_EVENT_SLUGS.puttingNight),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/e/<slug>/i/<token>/respond', () => {
  it('takes a personal link’s answer, and 404s a forged token', async () => {
    const token = inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestCarlos,
      tokenVersion: 1,
    });
    const params = { params: Promise.resolve({ slug: SLUG, token }) };
    const res = await respondRoute.POST(
      post(`/api/e/${SLUG}/i/${token}/respond`, {
        responses: { [DEMO_EVENT_IDS.sessionReception]: 'maybe' },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).outcome.sessions[DEMO_EVENT_IDS.sessionReception]).toBe('maybe');
    const forged = `${token.slice(0, -2)}AA`;
    const bad = await respondRoute.POST(
      post(`/api/e/${SLUG}/i/${forged}/respond`, {
        responses: { [DEMO_EVENT_IDS.sessionReception]: 'going' },
      }),
      { params: Promise.resolve({ slug: SLUG, token: forged }) },
    );
    expect(bad.status).toBe(404);
  });
});

describe('QR check-in and staff', () => {
  const qr = () =>
    checkinToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestAvery,
      tokenVersion: 1,
    });

  it('refuses anyone who is not an owner or staff', async () => {
    const token = qr();
    const probe = await qrRoute.POST(post(`/api/e/${SLUG}/c/${token}`, { action: 'status' }), {
      params: Promise.resolve({ slug: SLUG, token }),
    });
    expect(await probe.json()).toEqual({ ok: true, person: null, staff: null });
    const res = await qrRoute.POST(
      post(`/api/e/${SLUG}/c/${token}`, {
        action: 'checkin',
        sessionId: DEMO_EVENT_IDS.sessionReception,
      }),
      { params: Promise.resolve({ slug: SLUG, token }) },
    );
    expect(res.status).toBe(403);
  });

  it('lets a signed-in owner check the guest in, once', async () => {
    sessionContext = () => h.auth;
    const token = qr();
    const params = () => ({ params: Promise.resolve({ slug: SLUG, token }) });
    const status = await qrRoute.POST(
      post(`/api/e/${SLUG}/c/${token}`, { action: 'status' }),
      params(),
    );
    expect((await status.json()).person.name).toBe('Avery Quill');
    const first = await qrRoute.POST(
      post(`/api/e/${SLUG}/c/${token}`, {
        action: 'checkin',
        sessionId: DEMO_EVENT_IDS.sessionReception,
      }),
      params(),
    );
    expect((await first.json()).result.state).toBe('checked_in');
    const again = await qrRoute.POST(
      post(`/api/e/${SLUG}/c/${token}`, {
        action: 'checkin',
        sessionId: DEMO_EVENT_IDS.sessionReception,
      }),
      params(),
    );
    expect((await again.json()).result.state).toBe('already');
  });

  it('claims nothing until the grant service says so, and the door list is a 404 without a grant', async () => {
    const claim = await claimRoute.POST(post('/api/e/checkin/session', { token: 'a'.repeat(43) }));
    expect(claim.status).toBe(404);
    expect(claim.headers.get('set-cookie')).toBeNull();
    const door = await doorRoute.GET(new NextRequest(`${ORIGIN}/api/e/checkin/${EVENT}/guests`), {
      params: Promise.resolve({ eventId: EVENT }),
    });
    expect(door.status).toBe(404);
  });

  it('records a view by beacon and remembers a personal link’s guest', async () => {
    const token = inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestBianca,
      tokenVersion: 1,
    });
    const res = await viewRoute.POST(
      post(`/api/e/${SLUG}/view`, { token, source: 'newsletter' }),
      slugParams(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/tiptop_ev_rsvp=/);
    const views = await h.store.list('event_page_views', h.auth.organizationId, {
      eq: { event_id: EVENT },
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ guest_id: DEMO_EVENT_IDS.guestBianca, source: 'newsletter' });
  });
});

describe('calendar files', () => {
  it('serves the public ICS without the hidden address, and the personal one with the link', async () => {
    const res = await icsRoute.GET(
      new NextRequest(`${ORIGIN}/e/${SLUG}/calendar.ics`),
      slugParams(),
    );
    expect(res.headers.get('content-type')).toMatch(/text\/calendar/);
    const text = await res.text();
    expect(text).toContain('METHOD:PUBLISH');
    expect(text).not.toContain('100 Example Avenue');
    const token = inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestAvery,
      tokenVersion: 1,
    });
    const mine = await personalIcsRoute.GET(
      new Request(`${ORIGIN}/e/${SLUG}/i/${token}/calendar.ics`),
      {
        params: Promise.resolve({ slug: SLUG, token }),
      },
    );
    const personal = (await mine.text()).replace(/\r\n /g, '');
    expect(personal).toContain('100 Example Avenue');
    expect(personal).toContain(`/e/${SLUG}/i/${token}`);
    expect(personal.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});

describe('host routes', () => {
  const idParams = { params: Promise.resolve({ id: EVENT }) };

  it('need a Copilot session', async () => {
    signedIn = () => err('unauthenticated', 'Sign in to continue.');
    const res = await guestsRoute.GET(
      new NextRequest(`${ORIGIN}/api/events/${EVENT}/guests`),
      idParams,
    );
    expect(res.status).toBe(401);
  });

  it('list, bulk-approve, and export only with confirmation', async () => {
    const list = await guestsRoute.GET(
      new NextRequest(`${ORIGIN}/api/events/${EVENT}/guests`),
      idParams,
    );
    expect((await list.json()).roster.guests).toHaveLength(6);
    const patch = new NextRequest(`${ORIGIN}/api/events/${EVENT}/guests`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', guestIds: [DEMO_EVENT_IDS.guestDana] }),
    });
    expect((await (await guestsRoute.PATCH(patch, idParams)).json()).changed).toBe(1);
    const unconfirmed = await exportRoute.GET(
      new NextRequest(`${ORIGIN}/api/events/${EVENT}/guests/export.csv`),
      idParams,
    );
    expect(unconfirmed.status).toBe(400);
    const csv = await exportRoute.GET(
      new NextRequest(`${ORIGIN}/api/events/${EVENT}/guests/export.csv?confirm=1&tab=going`),
      idParams,
    );
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(
      /attachment; filename=".+-guests-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });

  it('save registration settings and copy one personal link on demand', async () => {
    const put = new NextRequest(`${ORIGIN}/api/events/${EVENT}/registration`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: 200 }),
    });
    expect((await (await registrationRoute.PUT(put, idParams)).json()).registration.capacity).toBe(
      200,
    );
    const link = await linkRoute.GET(new NextRequest(`${ORIGIN}/x`), {
      params: Promise.resolve({ id: EVENT, gid: DEMO_EVENT_IDS.guestAvery }),
    });
    expect((await link.json()).invite).toMatch(new RegExp(`^http://localhost:3000/e/${SLUG}/i/`));
  });
});
