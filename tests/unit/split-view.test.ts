import { describe, expect, it } from 'vitest';
import { safeSplitPath } from '@/components/shell/split-view';

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
});
