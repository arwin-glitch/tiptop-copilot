import { describe, expect, it } from 'vitest';
import { backfillUrlFrom, callUrl } from '../../scripts/granola-backfill.mjs';

/**
 * The backfill driver reuses the webhook secret rather than asking for a
 * second one, so the URL rewrite is the piece that has to be exact: point it
 * at the wrong path and every call 404s, drop the token and every call 401s.
 */

const WEBHOOK = 'https://tiptop-copilot.onrender.com/api/integrations/granola/webhook?token=abc123';

describe('deriving the backfill URL', () => {
  it('swaps the endpoint while keeping the token', () => {
    const url = backfillUrlFrom(WEBHOOK);
    expect(url.pathname).toBe('/api/integrations/granola/backfill');
    expect(url.searchParams.get('token')).toBe('abc123');
  });

  it('tolerates a trailing slash on the webhook path', () => {
    expect(backfillUrlFrom(WEBHOOK.replace('/webhook?', '/webhook/?')).pathname).toBe(
      '/api/integrations/granola/backfill',
    );
  });

  it('refuses a URL with no token rather than making calls that all fail', () => {
    expect(() => backfillUrlFrom(WEBHOOK.split('?')[0]!)).toThrow(/token/i);
  });

  it('refuses a URL that is not the Granola webhook at all', () => {
    expect(() => backfillUrlFrom('https://example.com/somewhere?token=x')).toThrow(/Granola/i);
  });
});

/**
 * Which mode a call declares.
 *
 * This replaces a test of the old stopping rule — stop after two consecutive
 * pages with nothing new — which was worthless in the specific way that hurts:
 * it re-implemented the rule inside the test file rather than calling the
 * shipped code, so it proved only that the test agreed with itself. The rule
 * rested on Granola returning newest first, which Granola does not promise;
 * in production every catch-up stopped on page two of old history having
 * fetched nothing, and this suite stayed green for the three days it did so.
 *
 * A test that imports the real function cannot drift from it like that.
 */
describe('choosing the mode for a call', () => {
  const BASE = backfillUrlFrom(WEBHOOK);

  it('asks for a catch-up by default, and never mentions full', () => {
    const url = callUrl(BASE, { pages: 1 });
    expect(url.searchParams.get('full')).toBeNull();
    expect(url.searchParams.get('pages')).toBe('1');
  });

  it('declares a full import on the opening call when asked', () => {
    expect(callUrl(BASE, { pages: 1, full: true }).searchParams.get('full')).toBe('1');
  });

  it('never re-declares full once the walk has a cursor', () => {
    // A cursor continues a walk that already has its window. Re-declaring the
    // mode mid-walk would start it again from the top, for ever.
    const url = callUrl(BASE, { pages: 1, full: true, cursor: 'abc' });
    expect(url.searchParams.get('full')).toBeNull();
    expect(url.searchParams.get('cursor')).toBe('abc');
  });

  it('keeps the token through every call in the walk', () => {
    expect(callUrl(BASE, { pages: 1, cursor: 'abc' }).searchParams.get('token')).toBe('abc123');
  });
});
