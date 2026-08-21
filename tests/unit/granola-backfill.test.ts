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

/**
 * The early stop is what makes hourly polling affordable: without it every run
 * would re-walk the whole history to discover the one note that arrived. Two
 * quiet pages rather than one, because an old note edited today surfaces among
 * recent ones and can produce a page that is all updates without meaning the
 * catch-up has reached the end.
 */
describe('catch-up stopping rule', () => {
  function runsUntilStop(pages: number[], stopAfterKnown: number): number {
    let quiet = 0;
    for (let i = 0; i < pages.length; i++) {
      quiet = pages[i]! > 0 ? 0 : quiet + 1;
      if (stopAfterKnown > 0 && quiet >= stopAfterKnown) return i + 1;
    }
    return pages.length;
  }

  it('stops after two consecutive pages with nothing new', () => {
    expect(runsUntilStop([3, 0, 0, 0, 0], 2)).toBe(3);
  });

  it('keeps going when a page in between still has something new', () => {
    // The trap: stopping on the first quiet page would miss the note on page 3.
    expect(runsUntilStop([2, 0, 1, 0, 0], 2)).toBe(5);
  });

  it('never stops early during a full import', () => {
    expect(runsUntilStop([0, 0, 0, 0, 0], 0)).toBe(5);
  });
});
