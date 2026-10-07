import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchEverything } from '@/lib/services/search';
import type { Deal } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/** The Ctrl+K box: one query across sources, in-app links only, org-scoped. */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('searchEverything', () => {
  it('finds a deal by part of its name and links inside the app', async () => {
    const deals = (await harness.store.list('deals', harness.auth.organizationId)) as Deal[];
    const target = deals[0]!;
    const fragment = target.company_name.slice(0, 4);
    const results = await searchEverything(harness.store, harness.auth.organizationId, fragment);
    const hit = results.find((r) => r.kind === 'deal' && r.label === target.company_name);
    expect(hit?.href).toBe(`/deals/${target.id}`);
    for (const r of results) expect(r.href.startsWith('/')).toBe(true);
  });

  it('ignores queries shorter than two characters', async () => {
    expect(await searchEverything(harness.store, harness.auth.organizationId, 'a')).toEqual([]);
  });

  it('never returns another organization’s records', async () => {
    const deals = (await harness.store.list('deals', harness.auth.organizationId)) as Deal[];
    const results = await searchEverything(
      harness.store,
      '00000000-0000-4000-8000-00000000dead',
      deals[0]!.company_name,
    );
    expect(results.filter((r) => r.kind === 'deal')).toEqual([]);
  });
});
