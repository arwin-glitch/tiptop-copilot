import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { NO_CONTACT_FILTER } from '@/lib/network/contact-status';
import { listCrmDirectory, sortDirectory, type DirectoryRow } from '@/lib/services/crm-directory';
import {
  relationshipScope,
  resetRelationshipCache,
  type RelationshipScope,
} from '@/lib/services/relationships';
import type { CrmRecord } from '@/lib/types/domain';

/**
 * All People / All Companies with computed status, connections and last
 * contact, on the demo store's invented records (every name fictional).
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
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

const list = (options: Parameters<typeof listCrmDirectory>[2]) =>
  listCrmDirectory(harness.store, harness.auth.organizationId, options, scope);

describe('listCrmDirectory', () => {
  it('pages people A to Z with their contact columns', async () => {
    const page = await list({ kind: 'person', limit: 5 });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.value.rows).toHaveLength(5);
    expect(page.value.total).toBeGreaterThan(5);
    expect(page.value.scanned).toBe(0);
    const names = page.value.rows.map((r) => r.record.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    for (const row of page.value.rows) {
      expect(row.record.kind).toBe('person');
      expect(row.contact?.status).toMatch(/^(recent|losing|lost|never)$/);
    }
  });

  it('filters never-contacted companies and sorts by last contact, empty last', async () => {
    const never = await list({
      kind: 'company',
      filter: { ...NO_CONTACT_FILTER, status: 'never' },
      limit: 200,
    });
    if (!never.ok) throw new Error(never.error.message);
    expect(never.value.rows.length).toBeGreaterThan(0);
    expect(never.value.rows.every((r) => r.contact?.lastContactAt === null)).toBe(true);

    const sorted = await list({ kind: 'company', sort: 'last_contact', dir: 'desc', limit: 200 });
    if (!sorted.ok) throw new Error(sorted.error.message);
    const dates = sorted.value.rows.map((r) => r.contact?.lastContactAt ?? null);
    const filled = dates.filter((d): d is string => d !== null);
    expect(filled).toEqual([...filled].sort().reverse());
    expect(dates.slice(filled.length).every((d) => d === null)).toBe(true);
  });

  it('keeps "contacted within N days" to records with a recent contact', async () => {
    const page = await list({
      kind: 'person',
      filter: { ...NO_CONTACT_FILTER, withinDays: 30 },
      limit: 200,
    });
    if (!page.ok) throw new Error(page.error.message);
    for (const row of page.value.rows) {
      const at = Date.parse(row.contact!.lastContactAt!);
      expect(NOW.getTime() - at).toBeLessThanOrEqual(31 * 86_400_000);
    }
  });
});

describe('sortDirectory', () => {
  const row = (name: string, at: string | null): DirectoryRow =>
    ({
      record: { name } as CrmRecord,
      contact: { lastContactAt: at, firstEmailAt: null, lastMeetingAt: null },
    }) as DirectoryRow;

  it('puts empty dates last in either direction and ties by name', () => {
    const rows = [row('B', null), row('A', '2026-01-01'), row('C', '2026-05-01'), row('D', null)];
    expect(sortDirectory(rows, 'last_contact', 'desc').map((r) => r.record.name)).toEqual([
      'C',
      'A',
      'B',
      'D',
    ]);
    expect(sortDirectory(rows, 'last_contact', 'asc').map((r) => r.record.name)).toEqual([
      'A',
      'C',
      'B',
      'D',
    ]);
  });
});
