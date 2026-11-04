import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { listLiveThreads, matchingThreadIds, resetInboxLiveCache } from '@/lib/services/inbox-live';

/** Gmail's "Select all N conversations": every id in the folder, in the demo without Gmail. */

let harness: Harness;
beforeEach(async () => {
  resetInboxLiveCache();
  harness = await createHarness();
});
afterEach(async () => {
  await harness.dispose();
});

describe('select all that match', () => {
  it('lists every demo conversation in the folder', async () => {
    const page = await listLiveThreads(harness.store, DEMO_IDS.org, { folder: 'inbox' });
    const all = await matchingThreadIds(harness.store, DEMO_IDS.org, { folder: 'inbox' });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.capped).toBe(false);
    expect(all.value.ids.sort()).toEqual(page.rows.map((r) => r.id).sort());
  });

  it('is not offered for Drafts, Scheduled or Snoozed', async () => {
    for (const folder of ['drafts', 'scheduled', 'snoozed'] as const) {
      expect((await matchingThreadIds(harness.store, DEMO_IDS.org, { folder })).ok).toBe(false);
    }
  });
});
