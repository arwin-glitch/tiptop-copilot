import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookingPage } from '@/components/booking/booking-page';
import { loadMeetPage, PAGE_VIEWS_PER_10_MIN } from '@/lib/booking/page-data';
import { SENT_MESSAGE } from '@/lib/booking/public';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { getStorage } from '@/lib/runtime';
import { resetLimiters } from '@/lib/security/limits';
import { setBookingPhoto } from '@/lib/services/booking';
import { proxy } from '@/proxy';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The booking link's public routes (D-074) as a browser reaches them: open
 * to anyone without a session (and only those paths: /meetings and the
 * signed-in booking API stay closed), a write only from the page itself,
 * per-address brakes, plain errors, and the photo served only while the link
 * is on.
 */

const { GET: slotsRoute } = await import('@/app/api/meet/[slug]/slots/route');
const { POST: requestRoute } = await import('@/app/api/meet/[slug]/request/route');
const { POST: chatRoute } = await import('@/app/api/meet/[slug]/chat/route');
const { GET: answerRoute } = await import('@/app/api/meet/[slug]/chat/answer/route');
const { GET: photoRoute } = await import('@/app/meet/[slug]/photo/route');

const ORIGIN = 'https://copilot.example';
const params = (slug = 'nick') => ({ params: Promise.resolve({ slug }) });

let harness: Harness;

function get(path: string, ip = '203.0.113.7') {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: { 'x-forwarded-for': ip, host: 'copilot.example' },
  });
}

function post(path: string, body: unknown, options: { origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip ?? '203.0.113.7',
    host: 'copilot.example',
  };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function firstCallSlot(): Promise<string> {
  const res = await slotsRoute(get('/api/meet/nick/slots?type=call'), params());
  const json = (await res.json()) as { slots: { start: string }[] };
  return json.slots[0]!.start;
}

const message = (email: string) => ({
  name: 'Pat Lee',
  email,
  type: 'message',
  note: 'Sharing our deck.',
  deckUrl: 'https://deck.example/acme',
});

beforeEach(async () => {
  harness = await createHarness();
  resetLimiters();
});

afterEach(async () => {
  await harness.dispose();
});

describe('who can reach it', () => {
  const reach = async (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`));

  it('opens the page, its photo and its three API routes without a session', async () => {
    for (const path of [
      '/meet/nick',
      '/meet/nick/photo',
      '/api/meet/nick/slots',
      '/api/meet/nick/request',
      '/api/meet/nick/chat',
    ]) {
      const res = await reach(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
    }
  });

  it('keeps everything else signed in, the Meetings page and the booking API included', async () => {
    for (const path of ['/meetings', '/meetx', '/calendar', '/settings']) {
      const res = await reach(path);
      expect(res.status, path).toBe(307);
      expect(res.headers.get('location'), path).toMatch(/\/login$/);
    }
    for (const path of [
      '/api/booking/requests/abc',
      '/api/booking/settings',
      '/api/booking/photo',
    ]) {
      expect((await reach(path)).status, path).toBe(401);
    }
  });
});

describe('a saved video link (hotfix)', () => {
  const ZOOM = 'https://example.zoom.us/j/1234567890?pwd=fictional';
  const leaks = (text: string) =>
    text.includes(ZOOM) || text.includes('example.zoom.us') || text.includes('1234567890');

  beforeEach(async () => {
    const org = harness.auth.organizationId;
    const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
    await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
      settings: { ...(row!.settings as Record<string, unknown>), callLink: ZOOM },
    });
  });

  it('is in no public response: the page data, its markup, times, chat or a request', async () => {
    const page = await loadMeetPage(harness.store, 'nick', 'visitor-key');
    expect(page.callProvider).toBe('Zoom call');
    // The page component is handed exactly this (the RSC payload), and renders it.
    expect(leaks(JSON.stringify(page))).toBe(false);
    const markup = renderToStaticMarkup(createElement(BookingPage, { data: page }));
    expect(markup).toContain('30-min Zoom call');
    expect(leaks(markup)).toBe(false);

    const texts: string[] = [];
    const slots = await slotsRoute(get('/api/meet/nick/slots?type=call'), params());
    const slotsText = await slots.text();
    texts.push(slotsText);
    const start = (JSON.parse(slotsText) as { slots: { start: string }[] }).slots[0]!.start;
    // The assistant (D-078): its opening, open times and questions.
    for (const body of [
      { action: 'start' },
      { action: 'times', type: 'call' },
      { action: 'ask', question: 'What is the Zoom link?', sessionId: 'video-link-0001' },
      { action: 'ask', question: 'How long is a call?', sessionId: 'video-link-0001' },
      { action: 'ask', question: 'Can we hop on a zoom?', sessionId: 'video-link-0001' },
    ]) {
      const res = await chatRoute(post('/api/meet/nick/chat', body), params());
      expect(res.status).toBe(200);
      texts.push(await res.text());
    }
    const sent = await requestRoute(
      post('/api/meet/nick/request', {
        name: 'Pat Lee',
        email: 'pat@acme.example',
        type: 'call',
        start,
      }),
      params(),
    );
    expect(sent.status).toBe(200);
    texts.push(await sent.text());
    for (const text of texts) expect(leaks(text), text).toBe(false);
    expect(texts.some((t) => t.includes('30-min Zoom call'))).toBe(true);
  });
});

describe('what the page says happens next (hotfix, D-078)', () => {
  it('names no person who confirms, reviews or approves', async () => {
    // Booked at once, the default (D-078).
    const page = await loadMeetPage(harness.store, 'nick', 'visitor-key');
    const markup = renderToStaticMarkup(createElement(BookingPage, { data: page }));
    expect(markup).toContain('30-min Google Meet');
    expect(markup).toContain('Booked straight onto the calendar');
    expect(markup).toContain('It goes straight onto the calendar');
    expect(markup).toContain('Book meeting');
    expect(markup).not.toMatch(/confirm|review|approv|Arwin will|the team/i);

    // Approve first, the option: a request that waits, still no person named.
    resetLimiters();
    const org = harness.auth.organizationId;
    const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
    await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
      settings: { ...(row!.settings as Record<string, unknown>), approveFirst: true },
    });
    const waiting = await loadMeetPage(harness.store, 'nick', 'visitor-key-2');
    const later = renderToStaticMarkup(createElement(BookingPage, { data: waiting }));
    expect(later).toContain('A calendar invitation once your time is booked');
    expect(later).toContain('You&#x27;ll get a calendar invitation once the time is booked.');
    expect(later).toContain('Send request');
    expect(later).not.toMatch(/confirm|review|approv|Arwin will|the team/i);
    expect(SENT_MESSAGE).toBe(
      "Request sent. You'll get a calendar invitation once the time is booked.",
    );
  });
});

describe('open times', () => {
  it('answers start and end instants only, never cached', async () => {
    const res = await slotsRoute(get('/api/meet/nick/slots?type=call'), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = (await res.json()) as Record<string, unknown> & {
      slots: Record<string, unknown>[];
    };
    expect(json).toMatchObject({
      ok: true,
      state: 'ok',
      type: 'call',
      hostTimeZone: 'America/Chicago',
    });
    expect(json.slots.length).toBeGreaterThan(0);
    for (const slot of json.slots) expect(Object.keys(slot).sort()).toEqual(['end', 'start']);
  });

  it('says closed for a link that is off or another slug', async () => {
    const other = await slotsRoute(get('/api/meet/someone/slots?type=call'), params('someone'));
    expect(await other.json()).toMatchObject({ ok: true, state: 'closed', slots: [] });
  });
});

describe('sending a request', () => {
  it('takes one from the page itself, and answers as the page says', async () => {
    const start = await firstCallSlot();
    const res = await requestRoute(
      post('/api/meet/nick/request', {
        name: 'Pat Lee',
        email: 'pat@acme.example',
        type: 'call',
        start,
      }),
      params(),
    );
    expect(res.status).toBe(200);
    // Booked at once (D-078): the status, the booking's own page, the booking.
    const json = (await res.json()) as Record<string, unknown> & { manageUrl: string };
    expect(json).toMatchObject({
      ok: true,
      status: 'booked',
      message: 'Booked.',
      booking: { status: 'booked', type: 'call', startsAt: start, guests: [] },
    });
    expect(json.manageUrl).toMatch(/^\/meet\/nick\/b\/[A-Za-z0-9_-]{43}$/);
    // This device remembers it: an httpOnly cookie sent to the link's own pages only.
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tiptop_booking_nick=${json.manageUrl.split('/').pop()}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/meet\/nick/i);
    const rows = await harness.store.list('booking_requests', harness.auth.organizationId, {
      eq: { email: 'pat@acme.example' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('booked');
    expect(rows[0]!.ip_hash).toMatch(/^[0-9a-f]{16,}$/);
    expect(rows[0]!.ip_hash).not.toContain('203.0.113.7');
  });

  it('refuses one from another site, or with no origin at all', async () => {
    const elsewhere = await requestRoute(
      post('/api/meet/nick/request', message('a@b.example'), { origin: 'https://evil.example' }),
      params(),
    );
    expect(elsewhere.status).toBe(403);
    const none = await requestRoute(
      post('/api/meet/nick/request', message('a@b.example'), { origin: null }),
      params(),
    );
    expect(none.status).toBe(403);
    expect(
      await harness.store.count('booking_requests', harness.auth.organizationId, {
        eq: { email: 'a@b.example' },
      }),
    ).toBe(0);
  });

  it('explains a bad form in plain words, and refuses an oversized one', async () => {
    const bad = await requestRoute(
      post('/api/meet/nick/request', { ...message('a@b.example'), deckUrl: 'javascript:alert(1)' }),
      params(),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', message: 'Use a link that starts with https://' },
    });
    const huge = await requestRoute(
      post('/api/meet/nick/request', { ...message('a@b.example'), note: 'x'.repeat(20_000) }),
      params(),
    );
    expect(huge.status).toBe(400);
    const junk = await requestRoute(post('/api/meet/nick/request', '{not json'), params());
    expect(junk.status).toBe(400);
  });

  it('brakes each address: three waiting at most, and five tries in ten minutes', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await requestRoute(
        post('/api/meet/nick/request', message(`p${i}@a.example`)),
        params(),
      );
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    // A fourth waiting request from the same address, under any email: no.
    const fourth = await requestRoute(
      post('/api/meet/nick/request', message('p3@a.example')),
      params(),
    );
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({
      error: {
        message:
          'You already have several meetings or messages on this link. Change or cancel one from its own page first.',
      },
    });
    await requestRoute(post('/api/meet/nick/request', message('p4@a.example')), params());
    // The sixth try in ten minutes is braked before anything is read.
    const sixth = await requestRoute(
      post('/api/meet/nick/request', message('p6@a.example')),
      params(),
    );
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).not.toMatchObject({
      error: {
        message: 'You already have requests waiting. Send another once those are answered.',
      },
    });
    const elsewhere = await requestRoute(
      post('/api/meet/nick/request', message('p7@a.example'), { ip: '198.51.100.20' }),
      params(),
    );
    expect(elsewhere.status).toBe(200);
  });

  it('is closed while the link is off', async () => {
    await harness.store.update(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
      {
        enabled: false,
      },
    );
    const res = await requestRoute(
      post('/api/meet/nick/request', message('a@b.example')),
      params(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { message: 'This booking link is not taking bookings right now.' },
    });
  });
});

describe('the assistant routes (D-078)', () => {
  it('answers the opening, open times and questions, from the page only', async () => {
    const start = await chatRoute(
      post('/api/meet/nick/chat', { action: 'start', timeZone: 'Europe/Lisbon' }),
      params(),
    );
    expect(start.status).toBe(200);
    const opening = (await start.json()) as { ok: boolean; action: string; places: unknown[] };
    expect(opening).toMatchObject({ ok: true, action: 'start' });
    expect(opening.places.length).toBeGreaterThan(0);

    const asked = await chatRoute(
      post('/api/meet/nick/chat', {
        action: 'ask',
        question: 'What stage do you invest in?',
        sessionId: 'route-session-0001',
      }),
      params(),
    );
    expect(await asked.json()).toMatchObject({ ok: true, kind: 'answer', matched: 'Stage' });

    const elsewhere = await chatRoute(
      post('/api/meet/nick/chat', { action: 'start' }, { origin: 'https://evil.example' }),
      params(),
    );
    expect(elsewhere.status).toBe(403);
    const unknown = await chatRoute(
      post('/api/meet/nick/chat', { action: 'start', tool: 'read_calendar' }),
      params(),
    );
    expect(unknown.status).toBe(400);
    const oldShape = await chatRoute(
      post('/api/meet/nick/chat', { mode: 'live', messages: [{ role: 'user', content: 'hi' }] }),
      params(),
    );
    expect(oldShape.status).toBe(400);
  });

  it('brakes each address before reading anything, even while the link is closed (review fix)', async () => {
    await harness.store.update(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
      { enabled: false },
    );
    const body = { action: 'start' };
    for (let i = 0; i < 60; i += 1) {
      expect((await chatRoute(post('/api/meet/nick/chat', body), params())).status).toBe(403);
    }
    expect((await chatRoute(post('/api/meet/nick/chat', body), params())).status).toBe(429);
  });

  it('answers a poll for an unknown or malformed question plainly, and brakes the poll', async () => {
    const malformed = await answerRoute(get('/api/meet/nick/chat/answer?id=nope'), params());
    expect(malformed.status).toBe(404);
    const unknown = await answerRoute(
      get('/api/meet/nick/chat/answer?id=12345678-1234-4234-8234-123456789012'),
      params(),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false });
    for (let i = 0; i < 90; i += 1) {
      await answerRoute(get('/api/meet/nick/chat/answer?id=nope', '203.0.113.9'), params());
    }
    const braked = await answerRoute(
      get('/api/meet/nick/chat/answer?id=nope', '203.0.113.9'),
      params(),
    );
    expect(braked.status).toBe(429);
  });
});

describe('the public page (review fix)', () => {
  it('shows the closed page to an address past its brake, and reads nothing for it', async () => {
    for (let i = 0; i < PAGE_VIEWS_PER_10_MIN; i += 1) {
      expect((await loadMeetPage(harness.store, 'nick', 'visitor-key')).state).toBe('open');
    }
    const braked = await loadMeetPage(harness.store, 'nick', 'visitor-key');
    expect(braked).toMatchObject({ state: 'closed', host: null, faq: '' });
    expect((await loadMeetPage(harness.store, 'nick', 'another-key')).state).toBe('open');
  });
});

describe('the host photo', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
  ]);

  it('is served by the app while the link is on, as the type it was checked to be', async () => {
    expect((await photoRoute(get('/meet/nick/photo'), params())).status).toBe(404);
    const saved = await setBookingPhoto(
      harness.store,
      getStorage(),
      harness.auth.organizationId,
      harness.auth.userId,
      PNG,
    );
    expect(saved.ok).toBe(true);
    const res = await photoRoute(get('/meet/nick/photo'), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    await harness.store.update(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
      {
        enabled: false,
      },
    );
    expect((await photoRoute(get('/meet/nick/photo'), params())).status).toBe(404);
    // Removed again: the stored file goes too.
    const removed = await setBookingPhoto(
      harness.store,
      getStorage(),
      harness.auth.organizationId,
      harness.auth.userId,
      null,
    );
    expect(removed.ok && removed.value.config.photo).toBeNull();
  });

  it('serves only the exact file an upload wrote, never another path in the bucket (review fix)', async () => {
    const org = harness.auth.organizationId;
    const canary = `booking/${org}/../../secret-docs/canary.pdf`;
    await getStorage().put(
      canary,
      new TextEncoder().encode('CANARY-PRIVATE-DOCUMENT'),
      'image/png',
    );
    const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
    for (const photo of [
      { path: canary, type: 'image/png', version: 'abcd1234' },
      {
        path: `booking/${org}/host-photo-abcd1234.png/../x`,
        type: 'image/png',
        version: 'abcd1234',
      },
      { path: `booking/${org}/host-photo-abcd1234.jpg`, type: 'image/png', version: 'abcd1234' },
    ]) {
      // Written straight into the row, as a hand-made save might once have.
      await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
        settings: { ...(row!.settings as Record<string, unknown>), photo },
      });
      const res = await photoRoute(get('/meet/nick/photo'), params());
      expect(res.status, photo.path).toBe(404);
      expect(await res.text()).not.toContain('CANARY');
    }
  });

  it('takes only a real JPG, PNG or WebP under 3 MB', async () => {
    const gif = new TextEncoder().encode('GIF89a-not-allowed');
    const refused = await setBookingPhoto(
      harness.store,
      getStorage(),
      harness.auth.organizationId,
      harness.auth.userId,
      gif,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('unsupported_media_type');
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    expect(
      (
        await setBookingPhoto(
          harness.store,
          getStorage(),
          harness.auth.organizationId,
          harness.auth.userId,
          svg,
        )
      ).ok,
    ).toBe(false);
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set(PNG);
    const tooBig = await setBookingPhoto(
      harness.store,
      getStorage(),
      harness.auth.organizationId,
      harness.auth.userId,
      big,
    );
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.code).toBe('too_large');
  });
});
