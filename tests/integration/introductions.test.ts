import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import type { AuthContext } from '@/lib/auth/session';
import { addCounts, NO_COUNTS, type AffinityCounts } from '@/lib/crm/affinity-csv';
import {
  buildIntroductionsImport,
  readAffinityIntroductions,
} from '@/lib/crm/affinity-introductions';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId } from '@/lib/demo/ids';
import {
  importAffinityIntroductions,
  INTRODUCTION_ACTION,
  introductionsForRecord,
} from '@/lib/services/introductions';
import type { AuditEvent, CrmRecord } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';

/**
 * Affinity introductions from file to profile: parsed as the page parses
 * them, sent through the import route and service, stored as sidecar rows,
 * and read back onto the demo store's invented companies and people.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const PEOPLE = readFileSync(path.join(FIXTURES, 'affinity_introductions_people.csv'), 'utf8');
const ORGS = readFileSync(path.join(FIXTURES, 'affinity_introductions_orgs.csv'), 'utf8');

const rec = (n: number) => demoCrmId('record', n);
const JUNIPER = rec(6);
const RIVERLIGHT = rec(14);
const ADA = rec(16);
const MAREN = rec(20);
const DESMOND = rec(21);
const HANA = rec(24);

let harness: Harness;
let store: DataStore;
let org: string;
let signedIn: () => Result<AuthContext> = () => ok(harness.auth);

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
}));

const { POST } = await import('@/app/api/crm/import/route');

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  signedIn = () => ok(harness.auth);
});

afterEach(async () => {
  await harness.dispose();
});

async function importFile(text: string, rowsPerChunk?: number) {
  const read = readAffinityIntroductions(text);
  if (!read) throw new Error('expected an introductions export');
  let counts: AffinityCounts = NO_COUNTS;
  let linked = 0;
  for (const request of buildIntroductionsImport(read.mapping, { rowsPerChunk }).requests) {
    const result = await importAffinityIntroductions(store, org, request);
    if (!result.ok) throw new Error(result.error.message);
    counts = addCounts(counts, result.value.introductions);
    linked += result.value.linked;
  }
  return { counts, linked };
}

async function introductionsOf(id: string) {
  const record = (await store.get('crm_records', org, id)) as CrmRecord;
  const result = await introductionsForRecord(store, org, record);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('importing introductions', () => {
  it('goes through the import route in the shape the page sends', async () => {
    const read = readAffinityIntroductions(PEOPLE);
    const [request] = buildIntroductionsImport(read!.mapping).requests;
    const response = await POST(
      new NextRequest('http://localhost/api/crm/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    const body = (await response.json()) as {
      ok: boolean;
      kind: string;
      introductions: AffinityCounts;
      linked: number;
    };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, kind: 'introductions', linked: 8 });
    expect(body.introductions).toMatchObject({ inserted: 9, unchanged: 0 });
  });

  it('rejects an introductions body that is not the agreed shape', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/crm/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'introductions',
          introductions: [{ externalId: 'x', section: 'gossip', introducer: {}, introduced: [] }],
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('adds nothing the second time, and only what is new from another list', async () => {
    expect(await importFile(PEOPLE, 4)).toEqual({
      counts: { ...NO_COUNTS, inserted: 9 },
      linked: 8,
    });
    expect((await importFile(PEOPLE)).counts).toEqual({ ...NO_COUNTS, unchanged: 9 });
    // The organization list names two of the same introductions — now with
    // the organization each introducer works at — and one new one.
    expect((await importFile(ORGS)).counts).toEqual({ ...NO_COUNTS, inserted: 1, updated: 2 });
    expect((await importFile(ORGS)).counts).toEqual({ ...NO_COUNTS, unchanged: 3 });
  });

  it('never keys an introduction by the fund’s own address', async () => {
    await importFile(PEOPLE);
    const rows = (await store.list('audit_events', org, {
      eq: { action: INTRODUCTION_ACTION },
    })) as AuditEvent[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.entity_id === 'email:nick@tiptop.demo')).toBe(false);
    // ...though the introduction still says who it was with.
    const ada = rows.find((r) => r.entity_id === 'email:ada@brindlehealth.example');
    expect(JSON.stringify(ada?.metadata)).toContain('nick@tiptop.demo');
  });
});

describe('introductions on a profile', () => {
  beforeEach(async () => {
    await importFile(PEOPLE);
    await importFile(ORGS);
  });

  it('shows who introduced a person, once, linked to their profile', async () => {
    const { introducedBy, introduced } = await introductionsOf(ADA);
    expect(introduced).toEqual([]);
    expect(introducedBy).toHaveLength(1);
    expect(introducedBy[0]).toMatchObject({
      date: '2026-03-14',
      evidence: 'email',
      partyRecordId: HANA,
      party: { name: 'Hana Kuroda', email: 'hana@riverlight.example' },
    });
    expect(introducedBy[0]?.others.map((p) => p.name)).toEqual(['Nick Tippmann']);
  });

  it('shows whom a person introduced, newest first, undated last', async () => {
    const { introduced } = await introductionsOf(HANA);
    expect(introduced.map((l) => [l.party.name, l.date])).toEqual([
      ['Juniper Robotics', '2026-06-02'],
      ['Rafael Quintero', '2026-06-02'],
      ['Ada Brennan', '2026-03-14'],
      ['Sven Malmberg', null],
    ]);
    expect(introduced.find((l) => l.party.name === 'Juniper Robotics')?.partyRecordId).toBe(
      JUNIPER,
    );
  });

  it('matches "made to" and "made by" of one introduction as one', async () => {
    const { introducedBy } = await introductionsOf(MAREN);
    expect(introducedBy).toHaveLength(1);
    expect(introducedBy[0]).toMatchObject({ partyRecordId: DESMOND, date: '2026-01-09' });
  });

  it('shows an organization the introductions its people made', async () => {
    const { introduced } = await introductionsOf(RIVERLIGHT);
    expect(introduced.map((l) => l.party.name)).toEqual(['Ada Brennan']);
    // An organization introduced by name: Juniper Robotics, by Hana.
    const juniper = await introductionsOf(JUNIPER);
    expect(juniper.introducedBy.map((l) => l.party.name)).toEqual(['Hana Kuroda']);
  });
});
