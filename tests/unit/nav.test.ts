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

  it('matches whole path segments only', () => {
    expect(sectionLabel('/listsx')).toBeNull();
    expect(sectionLabel('/deals/abc')).toBe('Deals');
    const knowledge = NAV_ITEMS.find((i) => i.href === '/knowledge');
    expect(knowledge && isActive('/lists/abc', knowledge)).toBe(true);
    const deals = NAV_ITEMS.find((i) => i.href === '/deals');
    expect(deals && isActive('/lists/abc', deals)).toBe(false);
  });
});
