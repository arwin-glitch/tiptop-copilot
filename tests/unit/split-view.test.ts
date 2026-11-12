import { describe, expect, it } from 'vitest';
import { droppedPath, isLinkDrag, safeSplitPath } from '@/components/shell/split-view';

/** Split view only ever shows Kraken's own pages. */
describe('split view', () => {
  it('keeps Kraken paths and refuses anything else', () => {
    expect(safeSplitPath('/calendar')).toBe('/calendar');
    expect(safeSplitPath('/inbox?thread=abc')).toBe('/inbox?thread=abc');
    expect(safeSplitPath('https://evil.example')).toBe('/inbox');
    expect(safeSplitPath('//evil.example')).toBe('/inbox');
    expect(safeSplitPath('/api/inbox/thread')).toBe('/inbox');
    expect(safeSplitPath(null)).toBe('/inbox');
  });

  it('splits on a dropped Kraken link only', () => {
    const o = 'https://kraken.example.test';
    expect(droppedPath(`${o}/calendar`, o)).toBe('/calendar');
    expect(droppedPath(`# comment\r\n${o}/deals?tab=pipeline`, o)).toBe('/deals?tab=pipeline');
    expect(droppedPath('https://other.example/calendar', o)).toBeNull();
    expect(droppedPath(`${o}/api/inbox/thread`, o)).toBeNull();
    expect(droppedPath('', o)).toBeNull();
  });

  it('treats only link drags as split drags', () => {
    expect(isLinkDrag(['text/uri-list', 'text/plain'])).toBe(true);
    expect(isLinkDrag(['Files'])).toBe(false);
    expect(isLinkDrag(['text/uri-list', 'application/x-kraken-threads'])).toBe(false);
    expect(isLinkDrag(['text/plain'])).toBe(false);
  });
});
