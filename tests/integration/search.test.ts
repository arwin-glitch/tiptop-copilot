import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchEverything } from '@/lib/services/search';
import { searchPreview } from '@/lib/services/search-preview';
import { demoCrmId } from '@/lib/demo/ids';
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

describe('quick search: CRM notes and the preview panel', () => {
  it('finds a CRM note by its text and opens its record on the Notes tab', async () => {
    const results = await searchEverything(
      harness.store,
      harness.auth.organizationId,
      'prior authorisations',
    );
    const note = results.find((r) => r.kind === 'crm_note');
    expect(note).toBeDefined();
    expect(note!.href).toMatch(/^\/lists\/records\/[0-9a-f-]+\?tab=notes$/);
    expect(note!.recordId).toBeTruthy();
  });

  it('previews a company: lists, status tag, counts and last contact', async () => {
    const preview = await searchPreview(harness.store, harness.auth, demoCrmId('record', 0));
    if (!preview.ok) throw new Error(preview.error.message);
    const p = preview.value;
    expect(p.kind).toBe('company');
    expect(p.href).toBe(`/lists/records/${demoCrmId('record', 0)}`);
    expect(p.counts.notes).toBeGreaterThan(0);
    expect(p.contact?.status).toMatch(/^(recent|losing|lost|never)$/);
    expect(p.listCount).toBeGreaterThanOrEqual(p.lists.length);
  });

  it('refuses an id that is not a record', async () => {
    const preview = await searchPreview(harness.store, harness.auth, 'not-a-uuid');
    expect(preview.ok).toBe(false);
  });
});
