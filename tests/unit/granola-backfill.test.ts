import { describe, expect, it } from 'vitest';
import { backfillUrlFrom } from '../../scripts/granola-backfill.mjs';

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
