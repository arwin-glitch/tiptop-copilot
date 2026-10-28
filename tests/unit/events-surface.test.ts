import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NONCE_HEADER,
  SURFACE_HEADER,
  eventCsp,
  isPrivateEventPath,
  isPublicSurfacePath,
  newNonce,
  wantsEventCsp,
} from '@/lib/events/surface';
import { proxy } from '@/proxy';

/**
 * The public surface (D-075): event pages are same-origin with Kraken, so
 * they get their own strict nonce CSP, none of Kraken's chrome, no service
 * worker interception, and no indexing of personal paths. A blocking check
 * for the integrator: if any of this slips, an LP gets Kraken's worker or
 * an outsider's script runs next to Nick's session.
 */

const ORIGIN = 'https://copilot.example';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('paths', () => {
  it('/e and /meet are the public surface; /events is not', () => {
    expect(isPublicSurfacePath('/e')).toBe(true);
    expect(isPublicSurfacePath('/e/harborview')).toBe(true);
    expect(isPublicSurfacePath('/meet/nick')).toBe(true);
    expect(isPublicSurfacePath('/events')).toBe(false);
    expect(isPublicSurfacePath('/events/abc/studio')).toBe(false);
    expect(isPublicSurfacePath('/edit')).toBe(false);
    expect(wantsEventCsp('/api/e/x/rsvp')).toBe(false);
  });

  it('personal and staff paths are private', () => {
    for (const p of [
      '/e/edit',
      '/e/edit/123',
      '/e/checkin',
      '/e/checkin/123',
      '/e/party/i/tok',
      '/e/party/c/tok',
    ]) {
      expect(isPrivateEventPath(p)).toBe(true);
    }
    for (const p of ['/e/party', '/e/party/calendar.ics', '/e/i', '/e/c']) {
      expect(isPrivateEventPath(p)).toBe(false);
    }
  });
});

describe('the event CSP', () => {
  it('allows only nonce-stamped scripts, our origin and the Supabase project', () => {
    const nonce = newNonce();
    const csp = eventCsp({ nonce, supabaseUrl: 'https://abcd.supabase.co' });
    const directives = Object.fromEntries(
      csp.split('; ').map((d) => {
        const [name, ...values] = d.split(' ');
        return [name, values];
      }),
    );
    expect(directives['script-src']).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(directives['img-src']).toContain('https://abcd.supabase.co');
    expect(directives['connect-src']).toEqual(["'self'", 'https://abcd.supabase.co']);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-src']).toContain('https://www.youtube-nocookie.com');
    expect(directives['script-src']).not.toContain('https://challenges.cloudflare.com');
  });

  it('adds Turnstile only when it is on, and eval only in development', () => {
    const on = eventCsp({ nonce: 'n', turnstile: true });
    expect(on).toMatch(/script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(eventCsp({ nonce: 'n', dev: true })).toMatch(/'unsafe-eval'/);
  });

  it('a nonce is fresh every time', () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('the proxy', () => {
  it('serves /e pages without a session, with a nonce CSP the page can read', async () => {
    const response = await proxy(new NextRequest(`${ORIGIN}/e/harborview-annual-meeting`));
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toMatch(/'strict-dynamic'/);
    // The request the page renders with carries the same nonce and the flag.
    expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);
    expect(response.headers.get(`x-middleware-request-${SURFACE_HEADER}`)).toBe('public');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('personal paths are never indexed; the door list may use the camera', async () => {
    const invite = await proxy(new NextRequest(`${ORIGIN}/e/party/i/sometoken`));
    expect(invite.headers.get('x-robots-tag')).toMatch(/noindex/);
    const door = await proxy(new NextRequest(`${ORIGIN}/e/checkin/abc`));
    expect(door.headers.get('permissions-policy')).toMatch(/camera=\(self\)/);
    const page = await proxy(new NextRequest(`${ORIGIN}/e/party`));
    expect(page.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
  });

  it('/api/e is public; /events and /api/events stay signed in', async () => {
    expect(
      (await proxy(new NextRequest(`${ORIGIN}/api/e/party/rsvp`, { method: 'POST' }))).status,
    ).toBe(200);
    expect((await proxy(new NextRequest(`${ORIGIN}/api/events`))).status).toBe(401);
    expect((await proxy(new NextRequest(`${ORIGIN}/events`))).status).toBe(307);
  });

  it('a client cannot fake the surface flag or a nonce onto a Kraken page', async () => {
    const response = await proxy(
      new NextRequest(`${ORIGIN}/login`, {
        headers: { [SURFACE_HEADER]: 'public', [NONCE_HEADER]: 'forged' },
      }),
    );
    // The request is rewritten: the flag replaced with 'app', the nonce gone
    // (the override list is the full new header set, so it must not be empty).
    expect(response.headers.get(`x-middleware-request-${SURFACE_HEADER}`)).toBe('app');
    expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBeNull();
    const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(overridden).toContain(SURFACE_HEADER);
    expect(overridden).not.toContain(NONCE_HEADER);
    // Kraken's own CSP, not an event one.
    expect(response.headers.get('content-security-policy')).toMatch(/'unsafe-inline'/);
  });

  it('a Kraken page keeps Kraken’s CSP and headers', async () => {
    const response = await proxy(new NextRequest(`${ORIGIN}/login`));
    expect(response.headers.get('content-security-policy')).toMatch(
      /script-src 'self' 'unsafe-inline'/,
    );
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get(`x-middleware-request-${SURFACE_HEADER}`)).toBeNull();
  });
});

describe('the service worker', () => {
  /** Run public/sw.js in a sandbox and report whether it intercepts a GET. */
  function intercepts(url: string, mode: 'navigate' | 'no-cors' = 'navigate'): boolean {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
    const listeners: Record<string, (event: unknown) => void> = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = fn;
      },
    };
    runInNewContext(source, { self, caches: {}, fetch: () => Promise.resolve(), URL, Response });
    let responded = false;
    listeners.fetch!({
      request: { method: 'GET', url, mode },
      respondWith: () => {
        responded = true;
      },
    });
    return responded;
  }

  it('never intercepts event or booking pages, but still handles Kraken navigations', () => {
    expect(intercepts(`${ORIGIN}/e/harborview-annual-meeting`)).toBe(false);
    expect(intercepts(`${ORIGIN}/e`)).toBe(false);
    expect(intercepts(`${ORIGIN}/e/party/i/token`)).toBe(false);
    expect(intercepts(`${ORIGIN}/meet/nick`)).toBe(false);
    expect(intercepts(`${ORIGIN}/api/e/party/rsvp`)).toBe(false);
    expect(intercepts(`${ORIGIN}/events`)).toBe(true);
    expect(intercepts(`${ORIGIN}/today`)).toBe(true);
  });
});

describe('robots.txt', () => {
  it('keeps crawlers to published event pages, never personal paths', async () => {
    const { default: robots } = await import('@/app/robots');
    const rules = robots().rules as { allow: string[]; disallow: string[] };
    expect(rules.allow).toContain('/e/');
    for (const p of ['/e/edit', '/e/checkin', '/e/*/i/', '/e/*/c/', '/'])
      expect(rules.disallow).toContain(p);
  });
});
