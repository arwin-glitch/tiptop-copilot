import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { demoCrmId } from '@/lib/demo/ids';
import { getRecord } from '@/lib/services/crm';
import { buildRelationshipList } from '@/lib/services/network';
import {
  getRecordRelationship,
  getRelationshipIndex,
  goingCold,
  networkStrengths,
  relationshipRowsForRecords,
  relationshipScope,
  resetRelationshipCache,
  withGoingCold,
  type RelationshipScope,
} from '@/lib/services/relationships';
import type { EmailMessage } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';

/**
 * Relationship intelligence end to end on the demo store: the demo
 * workspace's invented relationship history (relationship-fixtures.ts) and
 * CRM records, through the service and the list-columns route. Every person,
 * address and subject is invented, on .example domains.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ADA = demoCrmId('record', 16);
const BRINDLE = demoCrmId('record', 0);
const GULLWING = demoCrmId('record', 3);

let harness: Harness;
let store: DataStore;
let org: string;
let scope: RelationshipScope;
let signedIn: () => Result<AuthContext> = () => ok(harness.auth);

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
}));

beforeEach(async () => {
  resetRelationshipCache();
  harness = await createHarness({ now: NOW });
  store = harness.store;
  org = harness.auth.organizationId;
  scope = {
    ...relationshipScope(harness.auth.profile.email, { account_email: 'nick@tiptop.demo' }),
    now: NOW,
  };
  signedIn = () => ok(harness.auth);
});

afterEach(async () => {
  resetRelationshipCache();
  await harness.dispose();
});

async function profileOf(id: string) {
  const found = await getRecord(store, org, id);
  if (!found.ok) throw new Error(found.error.message);
  const { record, memberships, related } = found.value;
  const result = await getRecordRelationship(
    store,
    org,
    { record, memberships, related, timeZone: 'UTC' },
    scope,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('a person’s profile', () => {
  it('scores a well-kept founder relationship as Strong, with the evidence', async () => {
    const r = await profileOf(ADA);
    expect(r.matched).toEqual({ by: 'emails', addresses: 1, matchable: true });
    expect(r.evidence).toMatchObject({
      threads: 5,
      twoWayThreads: 5,
      meetingsHeld: 3,
    });
    expect(r.strength.label).toBe('strong');
    expect(r.strength.score).toBeGreaterThanOrEqual(90);
    expect(r.summary).toMatch(/^5 threads, last \w{3} \d+; 3 meetings, last .+; next meeting .+$/);
    expect(r.goingCold).toBe(false);
  });

  it('fills every smart field from mail and calendar', async () => {
    const r = await profileOf(ADA);
    for (const value of Object.values(r.smart)) expect(value.source).toBe('copilot');
    expect(Date.parse(r.smart.next_meeting.at as string)).toBeGreaterThan(NOW.getTime());
    expect(r.smart.last_contact.at).toBe(r.smart.last_email.at);
  });

  it('lists the booked meeting first, then recent threads that open in Gmail', async () => {
    const r = await profileOf(ADA);
    expect(r.timeline[0]).toMatchObject({ kind: 'meeting', upcoming: true });
    const thread = r.timeline.find((t) => t.kind === 'thread');
    expect(thread?.title).toBe('Customer reference for diligence');
    expect(thread?.href).toBe(
      'https://mail.google.com/mail/?authuser=nick%40tiptop.demo#all/de0a000000000005',
    );
  });

  it('names colleagues and who shares small threads with them', async () => {
    const r = await profileOf(ADA);
    expect(r.people.map((p) => p.name)).toEqual(['Cyrus Vale']);
    expect(r.introducers.map((p) => p.name)).toEqual(['Cyrus Vale', 'Hana Kuroda']);
  });
});

describe('a company’s profile', () => {
  it('counts everyone at its domain once, and links its people to their profiles', async () => {
    const r = await profileOf(BRINDLE);
    expect(r.matched.by).toBe('domain');
    expect(r.evidence.threads).toBe(5);
    expect(r.evidence.meetingsHeld).toBe(3);
    expect(r.strength.label).toBe('strong');
    expect(r.people.map((p) => [p.name, p.recordId])).toEqual([
      ['Ada Brennan', ADA],
      ['Cyrus Vale', null],
    ]);
    expect(r.people[1]?.strength.label).toBe('warm');
  });

  it('finds the person who made the intro, and never its own people', async () => {
    const r = await profileOf(BRINDLE);
    expect(r.introTarget).toMatchObject({ kind: 'domain', domains: ['brindlehealth.example'] });
    expect(r.introducers.map((p) => p.email)).toEqual(['hana@riverlight.example']);
  });

  it('falls back to the Affinity value, marked, when Copilot has no evidence', async () => {
    const r = await profileOf(GULLWING);
    // It has a domain, so this is "nothing on record", not "nothing to match on".
    expect(r.matched).toMatchObject({ by: 'none', matchable: true });
    expect(r.strength).toMatchObject({ score: 0, label: 'none' });
    expect(r.smart.last_contact.source).toBe('affinity');
    expect(r.smart.last_contact.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.smart.last_email).toEqual({ at: null, source: null });
  });
});

describe('a page of list rows', () => {
  it('answers for every known record in one call and skips unknown ids', async () => {
    const rows = await relationshipRowsForRecords(
      store,
      org,
      [BRINDLE, GULLWING, ADA, '99999999-9999-4999-8999-999999999999'],
      scope,
    );
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(Object.keys(rows.value).sort()).toEqual([BRINDLE, GULLWING, ADA].sort());
    expect(rows.value[BRINDLE]?.label).toBe('strong');
    expect(rows.value[GULLWING]?.smart.last_contact.source).toBe('affinity');
    expect(rows.value[ADA]?.summary).toMatch(/^5 threads/);
  });

  it('is served by the list-columns route', async () => {
    const { GET } = await import('@/app/api/crm/relationships/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/crm/relationships?ids=${BRINDLE},${GULLWING}`),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; rows: Record<string, { label: string }> };
    expect(json.ok).toBe(true);
    expect(json.rows[BRINDLE]?.label).toBe('strong');

    const bad = await GET(new NextRequest('http://localhost/api/crm/relationships?ids=nope'));
    expect(bad.status).toBe(400);
  });
});

describe('Network', () => {
  it('lists the same people the strengths are counted for', async () => {
    const rows = await buildRelationshipList(store, org, {
      ownAddresses: scope.ownAddresses as string[],
      now: NOW,
    });
    const emails = rows.map((r) => r.email);
    expect(emails).toContain('ada@brindlehealth.example');
    const strengths = await networkStrengths(
      store,
      org,
      [...emails, 'nobody@quiet.example'],
      scope,
    );
    expect(strengths.ok).toBe(true);
    if (!strengths.ok) return;
    expect(strengths.value['ada@brindlehealth.example']?.label).toBe('strong');
    expect(strengths.value['tomas@cobaltline.example']?.label).toBe('cold');
    expect(strengths.value['nobody@quiet.example']).toBeUndefined();
  });

  it('flags Strong and Warm relationships gone quiet, strongest first', async () => {
    const cold = await goingCold(store, org, scope);
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.value.map((p) => p.name)).toEqual(['Desmond Achterberg', 'Maren Solberg']);
    expect(cold.value[0]?.strength.label).toBe('strong');
    expect(cold.value[0]?.threadId).toMatch(/^[0-9a-f]{16}$/);

    const wider = await goingCold(store, org, scope, 70);
    expect(wider.ok && wider.value.map((p) => p.name)).toEqual(['Maren Solberg']);
  });

  it('folds its going-cold list into the relationship alerts without repeating anyone', async () => {
    const cold = await goingCold(store, org, scope);
    if (!cold.ok) throw new Error('going cold failed');
    const merged = withGoingCold(
      {
        run_at: NOW.toISOString(),
        waiting: [],
        cold: [
          {
            who: 'Maren Solberg',
            company: 'Oakhaven Capital',
            kind: 'prospective_lp',
            since: NOW.toISOString(),
            days: 76,
          },
        ],
      },
      cold.value,
      NOW,
    );
    expect(merged?.cold.map((c) => c.who)).toEqual(['Maren Solberg', 'Desmond Achterberg']);
    expect(merged?.cold[1]?.note).toMatch(/^Strong \(\d+\) · \d+ threads/);
    // One that has already faded says what it was.
    const faded = {
      ...cold.value[0]!,
      email: 'faded@quiet.example',
      name: 'Faded Contact',
      strength: { ...cold.value[0]!.strength, label: 'cold' as const, score: 22 },
    };
    expect(withGoingCold(null, [faded], NOW)?.cold[0]?.note).toMatch(/^Cold \(22\), was Strong · /);
    expect(withGoingCold(null, [], NOW)).toBeNull();
    expect(withGoingCold(null, cold.value, NOW)?.cold).toHaveLength(2);
  });
});

describe('the index', () => {
  it('counts every member of the fund as us, and reads the same for every viewer', async () => {
    // An invented colleague writes to a founder with Nick copied, and the founder answers.
    const colleague = 'sol.marsh@tiptop.demo';
    await harness.store.upsertUserProfile({
      id: '33333333-3333-4333-8333-333333333333',
      email: colleague,
      full_name: 'Sol Marsh',
      avatar_url: null,
      timezone: 'America/Chicago',
      theme: 'system',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    await store.insert('organization_members', {
      id: 'member-sol',
      organization_id: org,
      user_id: '33333333-3333-4333-8333-333333333333',
      role: 'member',
      created_at: NOW.toISOString(),
    });
    const [template] = (await store.list(
      'email_messages',
      org,
      {},
      { limit: 1 },
    )) as EmailMessage[];
    const sent = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    await store.insert('email_messages', {
      ...template!,
      id: '99999999-0000-4000-8000-000000000010',
      thread_id: 'colleague-thread',
      from_address: colleague,
      to_addresses: ['quill@mosswood.example'],
      cc_addresses: ['nick@tiptop.demo'],
      sent_at: sent(5),
    });
    await store.insert('email_messages', {
      ...template!,
      id: '99999999-0000-4000-8000-000000000011',
      thread_id: 'colleague-thread',
      from_address: 'quill@mosswood.example',
      to_addresses: [colleague, 'nick@tiptop.demo'],
      cc_addresses: [],
      sent_at: sent(4),
    });

    const asNick = await getRelationshipIndex(store, org, scope);
    const asColleague = await getRelationshipIndex(store, org, {
      ...relationshipScope(colleague, { account_email: 'nick@tiptop.demo' }),
      now: NOW,
    });
    expect(asNick.ok && asColleague.ok && asNick.value === asColleague.value).toBe(true);

    const strengths = await networkStrengths(
      store,
      org,
      ['quill@mosswood.example', colleague],
      scope,
    );
    if (!strengths.ok) throw new Error(strengths.error.message);
    // Two-way, started by the fund (8 + 8), not one inbound-only thread (1).
    expect(strengths.value['quill@mosswood.example']).toMatchObject({ label: 'cold', score: 16 });
    // A colleague is never a person in Nick's network.
    expect(strengths.value[colleague]).toBeUndefined();
  });

  it('is cached for a few minutes, and rebuilt on demand', async () => {
    const first = await getRelationshipIndex(store, org, scope);
    const again = await getRelationshipIndex(store, org, scope);
    expect(first.ok && again.ok && first.value === again.value).toBe(true);

    const message: EmailMessage = {
      ...((await store.list('email_messages', org, {}, { limit: 1 })) as EmailMessage[])[0]!,
      id: '99999999-0000-4000-8000-000000000001',
      from_address: 'new.person@fresh.example',
      sent_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    };
    await store.insert('email_messages', message);
    const cached = await networkStrengths(store, org, ['new.person@fresh.example'], scope);
    expect(cached.ok && cached.value['new.person@fresh.example']).toBeFalsy();
    resetRelationshipCache();
    const fresh = await networkStrengths(store, org, ['new.person@fresh.example'], scope);
    expect(fresh.ok && fresh.value['new.person@fresh.example']?.label).toBe('cold');
  });

  it('reads a store without the mail tables as no mail, and a broken one as an error', async () => {
    const missing = Object.create(store) as DataStore;
    missing.list = async () => {
      throw Object.assign(new Error('relation "email_messages" does not exist'), {
        code: '42P01',
      });
    };
    const empty = await getRelationshipIndex(missing, org, scope, { force: true });
    expect(empty.ok && empty.value.byAddress.size).toBe(0);

    const broken = Object.create(store) as DataStore;
    broken.list = async () => {
      throw new Error('connection reset');
    };
    const failed = await getRelationshipIndex(broken, org, scope, { force: true });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('provider_unavailable');
  });

  it('keeps one organization’s relationships from another', async () => {
    const other = await addSecondOrganization(harness);
    const strengths = await networkStrengths(
      store,
      other.organizationId,
      ['ada@brindlehealth.example'],
      scope,
    );
    expect(strengths.ok && strengths.value).toEqual({});
  });
});
