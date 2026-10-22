import { describe, expect, it } from 'vitest';
import { trackingToken } from '@/lib/campaigns/tokens';
import {
  CHECKIN_TOKEN_PURPOSE,
  GUEST_TOKEN_RE,
  RSVP_TOKEN_PURPOSE,
  checkinToken,
  inviteToken,
  parseGuestToken,
  readRememberCookie,
  rememberCookieOptions,
  rememberCookieValue,
  verifyGuestToken,
} from '@/lib/events/tokens';

/**
 * Personal invite and check-in tokens (D-075): stateless HMACs, purpose
 * tagged, per event, killed by rotating token_version. Fictional ids.
 */

const subject = {
  organizationId: '00000000-0000-4000-8000-00000000a001',
  eventId: '00000000-0000-4000-8000-00000000e001',
  guestId: '00000000-0000-4000-8000-00000000b001',
  tokenVersion: 1,
};

describe('guest tokens', () => {
  it('are opaque base64url with no PII, and verify for their own subject', () => {
    const token = inviteToken(subject);
    expect(token).toMatch(GUEST_TOKEN_RE);
    expect(token.length).toBe(66);
    expect(token).not.toContain('@');
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, token, subject)).toBe(true);
    expect(parseGuestToken(token)).toEqual({
      organizationId: subject.organizationId,
      guestId: subject.guestId,
    });
  });

  it('never cross purposes: an invite is not a check-in token, nor a campaign token', () => {
    const invite = inviteToken(subject);
    const checkin = checkinToken(subject);
    expect(invite).not.toBe(checkin);
    expect(verifyGuestToken(CHECKIN_TOKEN_PURPOSE, invite, subject)).toBe(false);
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, checkin, subject)).toBe(false);
    const campaign = trackingToken(subject.organizationId, subject.guestId);
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, campaign, subject)).toBe(false);
  });

  it('die when the guest’s token version is rotated', () => {
    const token = inviteToken(subject);
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, token, { ...subject, tokenVersion: 2 })).toBe(
      false,
    );
    expect(
      verifyGuestToken(RSVP_TOKEN_PURPOSE, inviteToken({ ...subject, tokenVersion: 2 }), {
        ...subject,
        tokenVersion: 2,
      }),
    ).toBe(true);
  });

  it('do not open another event or another guest', () => {
    const token = inviteToken(subject);
    expect(
      verifyGuestToken(RSVP_TOKEN_PURPOSE, token, {
        ...subject,
        eventId: '00000000-0000-4000-8000-00000000e002',
      }),
    ).toBe(false);
    expect(
      verifyGuestToken(RSVP_TOKEN_PURPOSE, token, {
        ...subject,
        guestId: '00000000-0000-4000-8000-00000000b002',
      }),
    ).toBe(false);
  });

  it('refuse tampering and junk', () => {
    const token = inviteToken(subject);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, flipped, subject)).toBe(false);
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, '', subject)).toBe(false);
    expect(verifyGuestToken(RSVP_TOKEN_PURPOSE, 'x'.repeat(66), subject)).toBe(false);
    expect(parseGuestToken('../etc/passwd')).toBeNull();
    expect(() => inviteToken({ ...subject, guestId: 'not-a-uuid' })).toThrow();
  });
});

describe('the remembered-RSVP cookie', () => {
  it('names the guest for this event only, until it expires', () => {
    const now = Date.now();
    const value = rememberCookieValue(subject, now);
    expect(readRememberCookie(value, subject.eventId, now)).toEqual({
      guestId: subject.guestId,
      tokenVersion: 1,
    });
    expect(readRememberCookie(value, '00000000-0000-4000-8000-00000000e002', now)).toBeNull();
    expect(readRememberCookie(value, subject.eventId, now + 400 * 86_400_000)).toBeNull();
    expect(readRememberCookie(`${value}x`, subject.eventId, now)).toBeNull();
    expect(readRememberCookie(null, subject.eventId, now)).toBeNull();
  });

  it('is httpOnly and scoped to the event’s own pages', () => {
    expect(rememberCookieOptions('spring-dinner', true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/e/spring-dinner',
    });
  });
});
