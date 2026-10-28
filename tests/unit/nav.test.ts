import { describe, expect, it } from 'vitest';
import { isActive, NAV_ITEMS, sectionLabel } from '@/components/shell/nav';

/**
 * The main navigation. Lists left it: Affinity's lists live under Knowledge,
 * so their pages (a list, a record profile) count as Knowledge.
 */

describe('the main navigation', () => {
  it('has no Lists entry', () => {
    expect(NAV_ITEMS.map((i) => i.label)).not.toContain('Lists');
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain('/lists');
  });

  it('marks Knowledge current on a list or a record profile', () => {
    expect(sectionLabel('/knowledge')).toBe('Knowledge');
    expect(sectionLabel('/lists/00000000-0000-4000-8000-000000000640')).toBe('Knowledge');
    expect(sectionLabel('/lists/records/00000000-0000-4000-8000-0000000006a4')).toBe('Knowledge');
    expect(sectionLabel('/lists')).toBe('Knowledge');
  });

  it('offers Download in a browser only', () => {
    const download = NAV_ITEMS.find((i) => i.href === '/download');
    expect(download && 'webOnly' in download && download.webOnly).toBe(true);
    expect(NAV_ITEMS.filter((i) => 'webOnly' in i).map((i) => i.href)).toEqual(['/download']);
  });

  it('names the full Ask page after Arwin in the phone header', () => {
    expect(sectionLabel('/ask')).toBe('Ask Arwin');
  });

  it('has an Events entry in the Working group, after Booking (D-075)', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain('/events');
    expect(hrefs.indexOf('/booking')).toBe(hrefs.indexOf('/calendar') + 1);
    expect(hrefs.indexOf('/events')).toBe(hrefs.indexOf('/booking') + 1);
    expect(NAV_ITEMS.find((i) => i.href === '/events')?.label).toBe('Events');
  });

  it('marks Events current on the library, one event and its tabs', () => {
    expect(sectionLabel('/events')).toBe('Events');
    expect(sectionLabel('/events/00000000-0000-4000-8000-0000e7e00001')).toBe('Events');
    // Segment-exact: the public guest pages under /e are not the Events tab.
    expect(sectionLabel('/e/harborview-annual-meeting')).toBeNull();
    expect(sectionLabel('/eventsx')).toBeNull();
  });

  it('matches whole path segments only', () => {
    expect(sectionLabel('/listsx')).toBeNull();
    expect(sectionLabel('/deals/abc')).toBe('Deals');
    const knowledge = NAV_ITEMS.find((i) => i.href === '/knowledge');
    expect(knowledge && isActive('/lists/abc', knowledge)).toBe(true);
    const deals = NAV_ITEMS.find((i) => i.href === '/deals');
    expect(deals && isActive('/lists/abc', deals)).toBe(false);
  });
});
