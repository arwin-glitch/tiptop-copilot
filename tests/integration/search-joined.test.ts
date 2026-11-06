import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { searchEverything } from '@/lib/services/search';
import type { CrmRecord } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/** A spaced query finds a joined name in the lists ("Bright Fund" → BrightFund). Fictional data. */

let harness: Harness;
beforeEach(async () => {
  harness = await createHarness({ now: new Date() });
});

describe('search, spaced vs joined names', () => {
  it('finds a company written as one word by its two words', async () => {
    const now = new Date().toISOString();
    const org = harness.auth.organizationId;
    const record: CrmRecord = {
      id: randomUUID(),
      organization_id: org,
      kind: 'company',
      source: 'copilot',
      external_id: null,
      name: 'BrightFund',
      name_key: 'brightfund',
      domain: 'brightfund.example',
      emails: [],
      primary_email: null,
      fields: {},
      created_at: now,
      updated_at: now,
    };
    await harness.store.insertMany('crm_records', [record]);
    const results = await searchEverything(harness.store, org, 'Bright Fund', harness.auth);
    expect(results.some((r) => r.kind === 'crm_company' && r.label === 'BrightFund')).toBe(true);
  });
});
