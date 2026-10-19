import { describe, expect, it } from 'vitest';
import {
  ALERT_KEYS_MAX,
  desktopPollAfterSeconds,
  hashDesktopToken,
  inDesktopPollWindow,
  mintDesktopToken,
  parseDesktopToken,
  toDesktopAlert,
} from '@/lib/services/desktop-alerts';

/**
 * Desktop alerts, the pure parts: the token's shape, when the shell asks
 * again, and how a phone alert is worded for a computer.
 */

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100';
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_RE = /^tcdsk_([0-9a-f]{32})_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const TZ = 'America/Chicago';

describe('desktop alert tokens', () => {
  it('carry the organization and the device, and 43 random characters', () => {
    const token = mintDesktopToken(ORG, DEVICE);
    expect(token).toMatch(TOKEN_RE);
    expect(token.startsWith(`tcdsk_${ORG.replace(/-/g, '')}_${DEVICE}_`)).toBe(true);
    expect(parseDesktopToken(token)).toEqual({ organizationId: ORG, device: DEVICE });
    expect(mintDesktopToken(ORG, DEVICE)).not.toBe(token);
  });

  it('are stored as a SHA-256 only', () => {
    const token = mintDesktopToken(ORG, DEVICE);
    expect(hashDesktopToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDesktopToken(token)).not.toContain(token.slice(-43));
  });

  it('refuse anything else', () => {
    const token = mintDesktopToken(ORG, DEVICE);
    for (const value of [
      '',
      token.replace('tcdsk_', 'tcmcp_'),
      `${token}x`,
      token.slice(0, -1),
      token.toUpperCase(),
      `tcdsk_${ORG.replace(/-/g, '')}_${DEVICE}`,
      `tcdsk_${ORG.replace(/-/g, '')}_${'G'.repeat(32)}_${'a'.repeat(43)}`,
    ]) {
      expect(parseDesktopToken(value), value).toBeNull();
    }
    expect(() => mintDesktopToken('not-a-uuid', DEVICE)).toThrow();
    expect(() => mintDesktopToken(ORG, 'short')).toThrow();
  });
});

describe('when the shell asks again', () => {
  // October is daylight time in Chicago: UTC-5.
  const at = (iso: string) => desktopPollAfterSeconds(new Date(iso), TZ);

  it('every minute from 6am to 9pm', () => {
    expect(at('2026-10-07T11:00:00Z')).toBe(60); // 6:00am
    expect(at('2026-10-07T17:00:00Z')).toBe(60); // noon
    expect(at('2026-10-08T01:59:00Z')).toBe(60); // 8:59pm
    expect(inDesktopPollWindow(new Date('2026-10-07T11:00:00Z'), TZ)).toBe(true);
    expect(inDesktopPollWindow(new Date('2026-10-08T02:00:00Z'), TZ)).toBe(false);
  });

  it('at night, not until 6am', () => {
    expect(at('2026-10-08T02:00:00Z')).toBe(9 * 3600); // 9:00pm
    expect(at('2026-10-08T04:00:00Z')).toBe(7 * 3600); // 11:00pm
    expect(at('2026-10-07T10:30:00Z')).toBe(30 * 60); // 5:30am
    expect(at('2026-10-07T10:59:00Z')).toBe(60); // 5:59am
    expect(at('2026-10-07T10:59:30Z')).toBe(60); // never sooner than a minute
  });

  it('across the night the clocks go back', () => {
    // 11pm daylight time on Oct 31 to 6am standard time on Nov 1: eight hours.
    expect(at('2026-11-01T04:00:00Z')).toBe(8 * 3600);
    // And forward in March: 11pm standard to 6am daylight is six hours.
    expect(at('2026-03-08T05:00:00Z')).toBe(6 * 3600);
  });
});

describe('a phone alert, worded for a computer', () => {
  it('says click, keeps the path, and marks meetings urgent', () => {
    expect(
      toDesktopAlert({
        keys: ['meeting:evt1:2026-10-07T15:05:00Z'],
        title: 'Intro call in 5 min',
        body: '10:05 AM · with Jordan Lee · Tap to join',
        url: '/go/meeting?id=evt1',
        tag: 'meeting-evt1',
      }),
    ).toEqual({
      keys: ['meeting:evt1:2026-10-07T15:05:00Z'],
      title: 'Intro call in 5 min',
      body: '10:05 AM · with Jordan Lee · Click to join',
      url: '/go/meeting?id=evt1',
      urgent: true,
    });
  });

  it('covers at most 50 items; the rest come next time', () => {
    const keys = Array.from({ length: 60 }, (_, i) => `wait:t-${i}`);
    const alert = toDesktopAlert({
      keys,
      title: 'Waiting on you',
      body: 'Jane LP, 6 days (+59 more)',
      url: '/follow-ups',
      tag: 'waiting',
    });
    expect(alert.keys).toEqual(keys.slice(0, ALERT_KEYS_MAX));
  });

  it('opens Today for a path that is not in the app', () => {
    const alert = toDesktopAlert({
      keys: ['risk:boost'],
      title: 'Portfolio company at risk',
      body: 'Boost: runway',
      url: 'https://example.com/portfolio',
      tag: 'risk',
    });
    expect(alert).toMatchObject({ url: '/today', urgent: false });
    expect(alert).not.toHaveProperty('tag');
  });
});
