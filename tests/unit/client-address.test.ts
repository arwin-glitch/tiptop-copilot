import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressBucket, addressKey, clientAddress } from '@/lib/security/client-address';
import { limiterBucketCount, rateLimit, resetLimiters } from '@/lib/security/limits';

/**
 * Abuse brakes on routes reached before anyone signs in. Their keys are
 * addresses an outsider picks, so an IPv6 caller is one key per /64, and the
 * limiter drops spent windows instead of keeping every key for ever.
 */

afterEach(() => {
  resetLimiters();
  vi.unstubAllEnvs();
});

describe('clientAddress', () => {
  it('prefers the edge address behind Cloudflare, then the last forwarded hop', () => {
    vi.stubEnv('TRUST_CF_CONNECTING_IP', 'true');
    expect(clientAddress(new Headers({ 'cf-connecting-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientAddress(new Headers({ 'x-forwarded-for': '10.0.0.1, 203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
    expect(clientAddress(new Headers())).toBe('unknown');
  });

  it('ignores a CF-Connecting-IP a client wrote when Cloudflare is not in front', () => {
    vi.stubEnv('TRUST_CF_CONNECTING_IP', '');
    vi.stubEnv('RENDER', '');
    const forged = new Headers({
      'cf-connecting-ip': '192.0.2.1',
      'x-forwarded-for': '192.0.2.1, 203.0.113.9',
    });
    expect(clientAddress(forged)).toBe('203.0.113.9');
    // Render serves through Cloudflare (and says so with RENDER=true).
    vi.stubEnv('RENDER', 'true');
    expect(clientAddress(forged)).toBe('192.0.2.1');
    // An explicit "false" wins over the guess.
    vi.stubEnv('TRUST_CF_CONNECTING_IP', 'false');
    expect(clientAddress(forged)).toBe('203.0.113.9');
    // Vercel's own edge header.
    vi.stubEnv('TRUST_CF_CONNECTING_IP', '');
    vi.stubEnv('RENDER', '');
    vi.stubEnv('VERCEL', '1');
    expect(
      clientAddress(
        new Headers({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }),
      ),
    ).toBe('198.51.100.7');
  });
});

describe('addressBucket', () => {
  it('keeps an IPv4 address whole', () => {
    expect(addressBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(addressBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('cuts an IPv6 address to its /64', () => {
    const a = addressBucket('2001:db8:aaaa:bbbb:1:2:3:4');
    const b = addressBucket('2001:0db8:aaaa:bbbb:ffff::9');
    expect(a).toBe('2001:db8:aaaa:bbbb::/64');
    expect(b).toBe(a);
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('[2001:db8:aaaa:cccc::1]')).toBe('2001:db8:aaaa:cccc::/64');
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('gives one limiter key to a whole /64, and never the raw address', () => {
    vi.stubEnv('TRUST_CF_CONNECTING_IP', 'true');
    const one = addressKey(new Headers({ 'cf-connecting-ip': '2001:db8:aaaa:bbbb::1' }));
    const two = addressKey(new Headers({ 'cf-connecting-ip': '2001:db8:aaaa:bbbb::2' }));
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('rate limiter memory', () => {
  it('drops spent windows once it holds many keys', () => {
    const start = 1_000_000;
    for (let i = 0; i < 5_100; i++) rateLimit(`flood:${i}`, 1, 1_000, start);
    expect(limiterBucketCount()).toBe(5_100);
    // A minute later every one of those windows is over: the next new key
    // clears them instead of joining them.
    rateLimit('fresh', 1, 1_000, start + 60_000);
    expect(limiterBucketCount()).toBe(1);
  });

  it('still limits while it prunes', () => {
    expect(rateLimit('same', 2, 60_000, 0).ok).toBe(true);
    expect(rateLimit('same', 2, 60_000, 1).ok).toBe(true);
    expect(rateLimit('same', 2, 60_000, 2).ok).toBe(false);
  });
});
