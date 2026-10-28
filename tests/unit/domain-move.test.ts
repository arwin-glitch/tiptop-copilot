import { describe, expect, it, vi } from 'vitest';
import { DOMAIN_MOVE_SCRIPT } from '@/lib/brand/domain-move';

/** Runs the inline script against a fake window and returns where it went, if anywhere. */
function run({
  href,
  desktop = false,
  framed = false,
  cookie = '',
}: {
  href: string;
  desktop?: boolean;
  framed?: boolean;
  cookie?: string;
}): string | null {
  const url = new URL(href);
  const replace = vi.fn();
  const win: Record<string, unknown> = {
    location: {
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace,
    },
  };
  win.top = framed ? {} : win;
  if (desktop) win.__TIPTOP_DESKTOP__ = '0.4.1';
  new Function('window', 'document', DOMAIN_MOVE_SCRIPT)(win, { cookie });
  return replace.mock.calls[0]?.[0] ?? null;
}

describe('the old-name → kraken.tiptop.vc move', () => {
  it('sends a browser to the same page on the new name', () => {
    expect(run({ href: 'https://copilot.tiptop.vc/meet/nick?d=2026-11-03#slots' })).toBe(
      'https://kraken.tiptop.vc/meet/nick?d=2026-11-03#slots',
    );
    expect(run({ href: 'https://copilot.tiptop.vc/' })).toBe('https://kraken.tiptop.vc/');
  });

  it('sends Render’s own address to the new name too', () => {
    expect(run({ href: 'https://tiptop-copilot.onrender.com/today?x=1' })).toBe(
      'https://kraken.tiptop.vc/today?x=1',
    );
    expect(run({ href: 'https://tiptop-copilot.onrender.com/today', desktop: true })).toBeNull();
  });

  it('leaves the desktop app on the old name', () => {
    expect(run({ href: 'https://copilot.tiptop.vc/today', desktop: true })).toBeNull();
    expect(
      run({ href: 'https://copilot.tiptop.vc/today', cookie: 'a=1; tiptop_desktop=0.4.1' }),
    ).toBeNull();
  });

  it('leaves frames and the desktop sign-in browser leg alone', () => {
    expect(run({ href: 'https://copilot.tiptop.vc/today', framed: true })).toBeNull();
    expect(run({ href: 'https://copilot.tiptop.vc/desktop/callback?h=x&code=y' })).toBeNull();
  });

  it('does nothing on any other host', () => {
    expect(run({ href: 'https://kraken.tiptop.vc/today' })).toBeNull();
    expect(run({ href: 'https://jobs.tiptop.vc/' })).toBeNull();
  });
});
