import { describe, expect, it } from 'vitest';
import { readTrackingToken, trackingToken, trackingUrls } from '@/lib/campaigns/tokens';
import { signedValue } from '@/lib/security/crypto';

/** Tracking tokens: signed, bound to one recipient and organization, and unforgeable. */

const ORG = '00000000-0000-4000-8000-000000000001';
const RECIPIENT = '00000000-0000-4000-8000-000000002100';
const OTHER = '00000000-0000-4000-8000-000000002101';

describe('tracking tokens', () => {
  it('round-trips the organization and recipient', () => {
    const token = trackingToken(ORG, RECIPIENT);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);
    expect(readTrackingToken(token)).toEqual({ organizationId: ORG, recipientId: RECIPIENT });
  });

  it('is the same token every time for the same recipient', () => {
    expect(trackingToken(ORG, RECIPIENT)).toBe(trackingToken(ORG, RECIPIENT));
    expect(trackingToken(ORG, RECIPIENT)).not.toBe(trackingToken(ORG, OTHER));
  });

  it('refuses a tampered signature', () => {
    const token = trackingToken(ORG, RECIPIENT);
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    expect(readTrackingToken(token.slice(0, -1) + last)).toBeNull();
  });

  it('refuses another recipient with this signature', () => {
    const [, mac] = trackingToken(ORG, RECIPIENT).split('.');
    const [ids] = trackingToken(ORG, OTHER).split('.');
    expect(readTrackingToken(`${ids}.${mac}`)).toBeNull();
  });

  it('refuses garbage, empty and oversized input', () => {
    for (const bad of [
      '',
      'abc',
      'a.b',
      'test',
      `${'A'.repeat(43)}.${'A'.repeat(22)}`,
      `${trackingToken(ORG, RECIPIENT)}.extra`,
      'x'.repeat(500),
    ]) {
      expect(readTrackingToken(bad)).toBeNull();
    }
    expect(readTrackingToken(null)).toBeNull();
  });

  it('cannot be stood in for by another signed value', () => {
    // A session-style signed value over the same ids must not verify.
    expect(readTrackingToken(signedValue(`${ORG}|${RECIPIENT}`))).toBeNull();
  });

  it('needs uuid ids', () => {
    expect(() => trackingToken('org', RECIPIENT)).toThrow();
  });

  it('builds the open, click and unsubscribe URLs on the app origin', () => {
    const urls = trackingUrls('https://copilot.example/', {
      organizationId: ORG,
      recipientId: RECIPIENT,
    });
    const token = trackingToken(ORG, RECIPIENT);
    expect(urls.open).toBe(`https://copilot.example/t/o/${token}`);
    expect(urls.unsubscribe).toBe(`https://copilot.example/t/u/${token}`);
    expect(urls.click('https://a.example/?q=1&r=2')).toBe(
      `https://copilot.example/t/c/${token}?u=https%3A%2F%2Fa.example%2F%3Fq%3D1%26r%3D2`,
    );
  });
});
