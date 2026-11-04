import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { CrmRecord } from '@/lib/types/domain';
import { demoCrmId } from '@/lib/demo/ids';
import {
  contactSummaries,
  relationshipScope,
  resetRelationshipCache,
  type RelationshipScope,
} from '@/lib/services/relationships';

/**
 * Status tags, last contact and connections for CRM records, on the demo
 * store's invented relationship history (every name and address fictional).
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ADA = demoCrmId('record', 16);

let harness: Harness;
let scope: RelationshipScope;

beforeEach(async () => {
  resetRelationshipCache();
  harness = await createHarness({ now: NOW });
  scope = {
    ...relationshipScope(harness.auth.profile.email, { account_email: 'nick@tiptop.demo' }),
    now: NOW,
  };
});

afterEach(async () => {
  resetRelationshipCache();
  await harness.dispose();
});

async function records(): Promise<CrmRecord[]> {
  return (await harness.store.list('crm_records', harness.auth.organizationId, {})) as CrmRecord[];
}

describe('contactSummaries', () => {
  it('gives every record a status, and a contacted one its last touch and connections', async () => {
    const all = await records();
    const result = await contactSummaries(harness.store, harness.auth.organizationId, all, scope);
    if (!result.ok) throw new Error(result.error.message);
    const ada = result.value[ADA];
    expect(ada).toBeDefined();
    expect(ada!.status).not.toBe('never');
    expect(ada!.lastContactAt).not.toBeNull();
    expect(ada!.lastTouchText).toBeTruthy();
    expect(ada!.connections.length).toBeGreaterThan(0);
    expect(ada!.connections[0]!.bars).toBeGreaterThan(0);

    // Every record has an answer, and at least one was never contacted.
    expect(Object.keys(result.value).sort()).toEqual(all.map((r) => r.id).sort());
    expect(Object.values(result.value).some((s) => s.status === 'never')).toBe(true);
  });

  it('answers nothing for no records without reading anything', async () => {
    const result = await contactSummaries(harness.store, harness.auth.organizationId, [], scope);
    expect(result).toEqual({ ok: true, value: {} });
  });
});
