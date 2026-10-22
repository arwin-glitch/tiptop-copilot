import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(await res.json()).toEqual({ ok: true, message: SENT_MESSAGE });
    const rows = await harness.store.list('booking_requests', harness.auth.organizationId, {
      eq: { email: 'pat@acme.example' },
    });
    expect(rows).toHaveLength(1);
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

  it('brakes each address: five in ten minutes', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await requestRoute(
        post('/api/meet/nick/request', message(`p${i}@a.example`)),
        params(),
      );
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const sixth = await requestRoute(
      post('/api/meet/nick/request', message('p6@a.example')),
      params(),
    );
    expect(sixth.status).toBe(429);
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

describe('the chatbot route', () => {
  it('answers the guided buttons, from the page only', async () => {
    const res = await chatRoute(
      post('/api/meet/nick/chat', {
        mode: 'guided',
        action: 'find_time',
        type: 'call',
        timeZone: 'Europe/Lisbon',
      }),
      params(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; mode: string; slots: unknown[] };
    expect(json).toMatchObject({ ok: true, mode: 'guided' });
    expect(json.slots.length).toBeGreaterThan(0);
    const elsewhere = await chatRoute(
      post(
        '/api/meet/nick/chat',
        { mode: 'guided', action: 'about' },
        { origin: 'https://evil.example' },
      ),
      params(),
    );
    expect(elsewhere.status).toBe(403);
    const unknown = await chatRoute(
      post('/api/meet/nick/chat', { mode: 'guided', tool: 'read_calendar' }),
      params(),
    );
    expect(unknown.status).toBe(400);
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
