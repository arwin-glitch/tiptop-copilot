import { describe, expect, it } from 'vitest';
import { isSupabaseAuthCookie } from '@/proxy';

/**
 * Recognising a Supabase session cookie.
 *
 * The proxy uses this to decide whether a request is carrying a session. It
 * used to test `name.endsWith('-auth-token')`, which silently fails for the
 * chunked form Supabase uses whenever the cookie exceeds 4KB — and a Google
 * identity, with a display name and an avatar URL, exceeds it.
 *
 * The result was a redirect loop with no error anywhere: the proxy concluded
 * there was no session and redirected /today to /login; the page reassembled
 * the chunks, resolved the session correctly, and redirected back. Server logs
 * showed `resolved` and `Auth session missing!` alternating several times a
 * second, and the browser showed ERR_TOO_MANY_REDIRECTS.
 */
describe('isSupabaseAuthCookie', () => {
  it('matches the unchunked cookie', () => {
    expect(isSupabaseAuthCookie('sb-zkpdrgcemkutfubpgmxw-auth-token')).toBe(true);
  });

  it('matches every chunk of a split cookie', () => {
    // The case that caused the loop.
    expect(isSupabaseAuthCookie('sb-zkpdrgcemkutfubpgmxw-auth-token.0')).toBe(true);
    expect(isSupabaseAuthCookie('sb-zkpdrgcemkutfubpgmxw-auth-token.1')).toBe(true);
    expect(isSupabaseAuthCookie('sb-zkpdrgcemkutfubpgmxw-auth-token.12')).toBe(true);
  });

  it('does not match this app’s own session cookies', () => {
    expect(isSupabaseAuthCookie('tiptop_session')).toBe(false);
    expect(isSupabaseAuthCookie('tiptop_demo_session')).toBe(false);
  });

  it('does not match unrelated cookies', () => {
    expect(isSupabaseAuthCookie('sb-something-else')).toBe(false);
    expect(isSupabaseAuthCookie('auth-token')).toBe(false);
    expect(isSupabaseAuthCookie('sb--auth-token')).toBe(false);
    expect(isSupabaseAuthCookie('')).toBe(false);
  });

  it('does not match a non-numeric suffix', () => {
    // Only the chunk form is a session cookie. A future `-auth-token.meta`
    // should not be mistaken for one.
    expect(isSupabaseAuthCookie('sb-abc-auth-token.meta')).toBe(false);
  });

  it('anchors both ends', () => {
    expect(isSupabaseAuthCookie('x-sb-abc-auth-token')).toBe(false);
    expect(isSupabaseAuthCookie('sb-abc-auth-token-extra')).toBe(false);
  });
});
