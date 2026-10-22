import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  FORM_MIN_MS,
  formToken,
  formTokenProblem,
  honeypotTripped,
  publicGate,
  readJsonBody,
  turnstileRequired,
  verifyTurnstile,
} from '@/lib/events/public-gate';
import { resetLimiters } from '@/lib/security/limits';

/**
 * The public endpoints' brakes (D-075): same-origin, body cap, address
 * bucket limits, honeypot, signed render time, Turnstile only when keyed and
 * only for open public events. No network: Turnstile's fetch is injected.
 */

const EVENT = '00000000-0000-4000-8000-00000000e001';

afterEach(() => {
  resetLimiters();
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

function request(headers: Record<string, string>, body = '{}') {
  return new NextRequest('http://localhost:3000/api/e/spring/rsvp', {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('signed render time', () => {
  it('refuses a submission under 2 s, one too old, and one for another event', () => {
    const issued = 1_000_000;
    const token = formToken(EVENT, issued);
    expect(formTokenProblem(token, EVENT, issued + 500)).toBe('too_fast');
    expect(formTokenProblem(token, EVENT, issued + FORM_MIN_MS + 1)).toBeNull();
    expect(formTokenProblem(token, EVENT, issued + 25 * 3_600_000)).toBe('expired');
    expect(formTokenProblem(token, '00000000-0000-4000-8000-00000000e002', issued + 5_000)).toBe(
      'invalid',
    );
    expect(formTokenProblem(`${token}x`, EVENT, issued + 5_000)).toBe('invalid');
    expect(formTokenProblem(undefined, EVENT)).toBe('invalid');
  });

  it('trips the honeypot on any value', () => {
    expect(honeypotTripped('')).toBe(false);
    expect(honeypotTripped(undefined)).toBe(false);
    expect(honeypotTripped('http://spam.example')).toBe(true);
  });
});

describe('publicGate', () => {
  it('refuses a write from another origin, or with no origin signal', () => {
    const cross = publicGate(request({ origin: 'https://evil.example' }), { limits: [] });
    expect(cross.ok).toBe(false);
    const none = publicGate(request({}), { limits: [] });
    expect(none.ok).toBe(false);
    const same = publicGate(request({ origin: 'http://localhost:3000' }), { limits: [] });
    expect(same.ok).toBe(true);
  });

  it('brakes per address bucket, IPv6 grouped by /64', async () => {
    const limit = { bucket: 'test-rsvp', max: 2, windowMs: 60_000 };
    const at = (ip: string) =>
      publicGate(request({ origin: 'http://localhost:3000', 'cf-connecting-ip': ip }), {
        limits: [limit],
      }).ok;
    expect(at('2001:db8:1:2::1')).toBe(true);
    expect(at('2001:db8:1:2::ffff')).toBe(true);
    expect(at('2001:db8:1:2:abcd::9')).toBe(false);
    expect(at('2001:db8:9:9::1')).toBe(true);
    const gate = publicGate(
      request({ origin: 'http://localhost:3000', 'cf-connecting-ip': '192.0.2.7' }),
      { limits: [] },
    );
    expect(gate.ok && gate.visitor.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(gate.ok && gate.visitor.key).not.toContain('192.0.2.7');
  });
});

describe('readJsonBody', () => {
  it('caps the body before parsing it', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(20_000) });
    const tooBig = await readJsonBody(request({ origin: 'http://localhost:3000' }, big));
    expect(tooBig.ok).toBe(false);
    expect(!tooBig.ok && tooBig.error.code).toBe('too_large');
    const bad = await readJsonBody(request({}, '{nope'));
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
    const good = await readJsonBody(request({}, '{"a":1}'));
    expect(good.ok && good.body).toEqual({ a: 1 });
  });
});

describe('Turnstile', () => {
  it('runs only with both keys, and only on open public events', () => {
    const open = { access: 'open', visibility: 'public' };
    expect(turnstileRequired(open)).toBe(false);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-for-tests';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key-for-tests';
    expect(turnstileRequired(open)).toBe(true);
    expect(turnstileRequired({ access: 'invite_only', visibility: 'unlisted' })).toBe(false);
    expect(turnstileRequired({ access: 'open', visibility: 'unlisted' })).toBe(false);
  });

  it('verifies through the injected fetch and fails closed', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret-key-for-tests';
    const ok = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstile('token', '192.0.2.1', ok as unknown as typeof fetch)).toBe(true);
    const sent = (ok.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body;
    expect(sent.get('secret')).toBe('secret-key-for-tests');
    expect(sent.get('remoteip')).toBe('192.0.2.1');
    const no = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await verifyTurnstile('token', null, no as unknown as typeof fetch)).toBe(false);
    const down = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await verifyTurnstile('token', null, down as unknown as typeof fetch)).toBe(false);
    expect(await verifyTurnstile('', null, ok as unknown as typeof fetch)).toBe(false);
  });
});
