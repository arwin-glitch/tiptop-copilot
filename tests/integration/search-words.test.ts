import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryWords, searchEverything } from '@/lib/services/search';
import type { CrmRecord } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Ctrl+K searches word by word, as Affinity does: "Bright Nordvik" finds the
 * company Bright and the person Lena Nordvik, with a record holding both
 * words first. Every name here is fictional.
 */

let harness: Harness;
beforeEach(async () => {
  harness = await createHarness({ now: new Date() });
});

function record(
  org: string,
  kind: CrmRecord['kind'],
  name: string,
  domain: string | null = null,
): CrmRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    organization_id: org,
    kind,
    source: 'copilot',
    external_id: null,
    name,
    name_key: name.toLowerCase(),
    domain,
    emails: [],
    primary_email: null,
    fields: {},
    created_at: now,
    updated_at: now,
  };
}

describe('queryWords', () => {
  it('splits, lowercases, drops one-letter words and repeats, keeps four', () => {
    expect(queryWords('  Bright  a Nordvik bright ')).toEqual(['bright', 'nordvik']);
    expect(queryWords('one two three four five')).toEqual(['one', 'two', 'three', 'four']);
    expect(queryWords('Bright')).toEqual(['bright']);
  });
});

describe('search, word by word', () => {
  it('finds each word on its own and ranks a record holding both first', async () => {
    const org = harness.auth.organizationId;
    await harness.store.insertMany('crm_records', [
      record(org, 'company', 'Bright', 'bright.example'),
      record(org, 'person', 'Lena Nordvik'),
      record(org, 'company', 'Nordvik Bright Labs', 'nbl.example'),
      record(org, 'company', 'Unrelated Co'),
    ]);
    const results = await searchEverything(harness.store, org, 'Bright Nordvik', harness.auth);
    const crm = results.filter((r) => r.kind === 'crm_company' || r.kind === 'crm_person');
    const labels = crm.map((r) => r.label);
    expect(labels[0]).toBe('Nordvik Bright Labs');
    expect(labels).toContain('Bright');
    expect(labels).toContain('Lena Nordvik');
    expect(labels).not.toContain('Unrelated Co');
    expect(crm[0]?.matched).toEqual(['bright', 'nordvik']);
    expect(crm.find((r) => r.label === 'Lena Nordvik')?.matched).toEqual(['nordvik']);
    expect(crm.find((r) => r.label === 'Bright')?.domain).toBe('bright.example');
    expect(crm.find((r) => r.label === 'Lena Nordvik')?.domain).toBeUndefined();
  });

  it('puts the whole phrase above a record holding the words apart', async () => {
    const org = harness.auth.organizationId;
    await harness.store.insertMany('crm_records', [
      record(org, 'company', 'Nordvik and Bright'),
      record(org, 'company', 'Bright Nordvik Partners'),
    ]);
    const results = await searchEverything(harness.store, org, 'Bright Nordvik', harness.auth);
    const labels = results.filter((r) => r.kind === 'crm_company').map((r) => r.label);
    expect(labels).toEqual(['Bright Nordvik Partners', 'Nordvik and Bright']);
  });

  it('leaves a one-word search as it was', async () => {
    const org = harness.auth.organizationId;
    await harness.store.insertMany('crm_records', [
      record(org, 'company', 'Brightwater', 'brightwater.example'),
      record(org, 'company', 'Bright', 'bright.example'),
      record(org, 'company', 'Upbright'),
      record(org, 'person', 'Lena Nordvik'),
    ]);
    const results = await searchEverything(harness.store, org, 'bright', harness.auth);
    const crm = results.filter((r) => r.kind === 'crm_company' || r.kind === 'crm_person');
    // Exact name, then prefix, then contains: searchRecords' own order.
    expect(crm.map((r) => r.label)).toEqual(['Bright', 'Brightwater', 'Upbright']);
    expect(crm.every((r) => r.matched?.[0] === 'bright')).toBe(true);
  });
});
