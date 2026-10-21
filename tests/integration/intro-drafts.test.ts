import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { DataStore } from '@/lib/db/store';
import { demoFollowUps } from '@/lib/demo/follow-ups-fixtures';
import { DEMO_IDS, demoCrmId } from '@/lib/demo/ids';
import { SIGN_OFF_NAME } from '@/lib/email/signatures';
import type { IntroItem } from '@/lib/services/follow-ups';
import { introDrafts, linkedInOf } from '@/lib/services/intro-drafts';
import { introductionRows } from '@/lib/services/introductions';
import type { CrmRecord, PortfolioContact } from '@/lib/types/domain';

/**
 * "Write the intro" over the demo store's invented companies and people:
 * every address comes from a record, a saved contact, an imported
 * introduction or the tracker's own row, and nothing is guessed.
 */

let harness: Harness;
let store: DataStore;
let org: string;

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
});

afterEach(async () => {
  await harness.dispose();
});

const owed = (for_who: string, to_who: string, extra: Partial<IntroItem> = {}): IntroItem => ({
  for_who,
  to_who,
  status: 'owed',
  ...extra,
});

function personRecord(name: string, email: string, fields: CrmRecord['fields'] = {}): CrmRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    organization_id: org,
    kind: 'person',
    source: 'copilot',
    external_id: null,
    name,
    name_key: name.toLowerCase(),
    domain: null,
    emails: [email],
    primary_email: email,
    fields,
    created_at: now,
    updated_at: now,
  };
}

function contact(name: string, email: string, is_founder: boolean): PortfolioContact {
  return {
    id: randomUUID(),
    organization_id: org,
    portfolio_company_id: DEMO_IDS.pcLedgerly,
    name,
    role: is_founder ? 'CTO' : 'VP Sales',
    email,
    is_founder,
    created_at: new Date().toISOString(),
  };
}

describe('intro drafts', () => {
  it('drafts the demo intro from Portfolio, the CRM and the tracker row', async () => {
    const intros = demoFollowUps(new Date()).intros!.intros;
    const drafts = await introDrafts(store, org, intros);
    // Owed intros only.
    expect(Object.keys(drafts).sort()).toEqual([
      'Harbor Labs → Northwind Capital',
      'Ledgerly → Hana Kuroda (Riverlight Ventures)',
    ]);
    const draft = drafts['Ledgerly → Hana Kuroda (Riverlight Ventures)']!;
    expect(draft.subject).toBe('Intro: Hana (Riverlight Ventures) <> Maya (Ledgerly)');
    expect(draft.to).toBe('Hana Kuroda <hana@riverlight.example>, Maya Chen <maya@ledgerly.demo>');
    expect(draft.body).toContain('Hi Hana & Maya,');
    expect(draft.body).toContain('Hana - meet Maya Chen, founder of Ledgerly.');
    expect(draft.body).toContain(
      'Maya - meet [Hana Kuroda](https://www.linkedin.com/in/hana-kuroda-example) at Riverlight Ventures.',
    );
    expect(draft.body.endsWith(`Cheers,\n${SIGN_OFF_NAME.nick}`)).toBe(true);
    expect(draft.hints).toEqual([
      'No LinkedIn on file for Maya Chen, so that name stays unlinked.',
    ]);
  });

  it('leaves firms nobody knows empty instead of guessing anyone there', async () => {
    const drafts = await introDrafts(store, org, [owed('Harbor Labs', 'Northwind Capital')]);
    const draft = drafts['Harbor Labs → Northwind Capital']!;
    expect(draft.to).toBe('');
    expect(draft.subject).toBe('Intro: Northwind Capital <> Harbor Labs');
    expect(draft.body).toContain('Northwind Capital team - meet the team at Harbor Labs.');
    expect(draft.hints).toHaveLength(2);
    expect(draft.hints[0]).toContain('who at Northwind Capital');
  });

  it('keeps a person nobody has an address for, and says so', async () => {
    const drafts = await introDrafts(store, org, [owed('Kit Morrow', 'Hana Kuroda')]);
    const draft = drafts['Kit Morrow → Hana Kuroda']!;
    expect(draft.to).toBe('Hana Kuroda <hana@riverlight.example>');
    expect(draft.subject).toBe('Intro: Hana <> Kit');
    expect(draft.hints).toContain('No email on file for Kit Morrow. Add it to To before sending.');
  });

  it('addresses every co-founder when the row names only one of them', async () => {
    await store.insert('portfolio_contacts', contact('Theo Park', 'theo@ledgerly.demo', true));
    const drafts = await introDrafts(store, org, [
      owed('Maya Chen (Ledgerly)', 'Hana Kuroda (Riverlight Ventures)'),
      owed('Maya Chen', 'Kit Morrow'),
    ]);
    const draft = drafts['Maya Chen (Ledgerly) → Hana Kuroda (Riverlight Ventures)']!;
    expect(draft.subject).toBe('Intro: Hana (Riverlight Ventures) <> Maya & Theo (Ledgerly)');
    expect(draft.to).toBe(
      'Hana Kuroda <hana@riverlight.example>, Maya Chen <maya@ledgerly.demo>, Theo Park <theo@ledgerly.demo>',
    );
    expect(draft.body.split('\n')[0]).toBe('Hi Hana, Maya & Theo,');
    expect(draft.body).toContain('Hana - meet Maya Chen and Theo Park, co-founders at Ledgerly.');
    // A founder named without the company: the company comes from Portfolio.
    expect(drafts['Maya Chen → Kit Morrow']!.subject).toBe('Intro: Kit <> Maya & Theo (Ledgerly)');
  });

  it('keeps a row that names someone other than a founder as written', async () => {
    await store.insertMany('portfolio_contacts', [
      contact('Theo Park', 'theo@ledgerly.demo', true),
      contact('Iris Quell', 'iris@ledgerly.demo', false),
    ]);
    const drafts = await introDrafts(store, org, [
      owed('Iris Quell (Ledgerly)', 'Hana Kuroda (Riverlight Ventures)'),
    ]);
    const draft = drafts['Iris Quell (Ledgerly) → Hana Kuroda (Riverlight Ventures)']!;
    expect(draft.subject).toBe('Intro: Hana (Riverlight Ventures) <> Iris (Ledgerly)');
    expect(draft.body).toContain('Hana - meet Iris Quell at Ledgerly.');
  });

  it('gives no address for a name two records share', async () => {
    await store.insertMany('crm_records', [
      personRecord('Rowan Vale', 'rowan@one.example'),
      personRecord('Rowan Vale', 'rowan@two.example'),
    ]);
    const drafts = await introDrafts(store, org, [owed('Rowan Vale', 'Hana Kuroda')]);
    expect(drafts['Rowan Vale → Hana Kuroda']!.to).toBe('Hana Kuroda <hana@riverlight.example>');
  });

  it("prefers the tracker's own people, and fills their gaps from records", async () => {
    const drafts = await introDrafts(store, org, [
      owed('Pellucid', 'Hana Kuroda', {
        for_org: 'Pellucid',
        for_people: [
          { name: 'Ola Brightwater', email: 'ola@pellucid.demo' },
          { name: 'Tamsin Marlowe', email: null },
        ],
      }),
    ]);
    const draft = drafts['Pellucid → Hana Kuroda']!;
    expect(draft.subject).toBe('Intro: Hana <> Ola & Tamsin (Pellucid)');
    expect(draft.to).toBe(
      'Hana Kuroda <hana@riverlight.example>, Ola Brightwater <ola@pellucid.demo>',
    );
    expect(draft.body.split('\n')[0]).toBe('Hi Hana, Ola & Tamsin,');
    expect(draft.hints).toContain(
      'No email on file for Tamsin Marlowe. Add it to To before sending.',
    );
  });

  it('reads an address from an imported introduction that places them at the firm', async () => {
    const intro = {
      externalId: 'demo-intro-1',
      section: 'made_by' as const,
      date: '2026-05-01',
      evidence: 'email' as const,
      introducer: {
        kind: 'person' as const,
        name: 'Ada Brennan',
        email: 'ada@brindlehealth.example',
      },
      introduced: [
        {
          kind: 'person' as const,
          name: 'Kit Morrow',
          email: 'kit@lanternfish.example',
          organization: { name: 'Lanternfish Bio', domain: 'lanternfish.example' },
        },
      ],
    };
    await store.insertMany(
      'audit_events',
      introductionRows(org, intro, new Set(), new Date().toISOString()),
    );
    const drafts = await introDrafts(store, org, [
      owed('Ledgerly', 'Kit Morrow (Lanternfish Bio)'),
      owed('Stonebridge Ops', 'Kit Morrow (Saltmarsh Labs)'),
    ]);
    expect(drafts['Ledgerly → Kit Morrow (Lanternfish Bio)']!.to).toContain(
      'Kit Morrow <kit@lanternfish.example>',
    );
    // The same name at another firm is not that person.
    expect(drafts['Stonebridge Ops → Kit Morrow (Saltmarsh Labs)']!.to).toBe(
      'Dev Sharma <dev@stonebridgeops.demo>',
    );
  });

  it('links a name from an imported LinkedIn column', async () => {
    await store.update('crm_records', org, demoCrmId('record', 25), {
      fields: { 'Job Title': 'CEO', 'LinkedIn Profile': 'linkedin.com/in/sven-malmberg-example' },
    });
    const drafts = await introDrafts(store, org, [owed('Sven Malmberg', 'Hana Kuroda')]);
    expect(drafts['Sven Malmberg → Hana Kuroda']!.body).toContain(
      'Hana - meet [Sven Malmberg](https://linkedin.com/in/sven-malmberg-example).',
    );
    expect(linkedInOf({ fields: { Website: 'https://www.linkedin.com/in/x' } })).toBeNull();
    expect(linkedInOf({ fields: { LinkedIn: ['https://evil.example/x'] } })).toBeNull();
  });

  it('still drafts when the CRM tables are not there yet', async () => {
    const missing = Object.assign(new Error('relation "public.crm_records" does not exist'), {
      code: '42P01',
    });
    const noCrm = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'list') {
          return async (table: string, ...rest: unknown[]) => {
            if (table.startsWith('crm_') || table === 'audit_events') throw missing;
            return (target.list as (...a: unknown[]) => unknown)(table, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DataStore;
    const drafts = await introDrafts(noCrm, org, [
      owed('Ledgerly', 'Hana Kuroda (Riverlight Ventures)'),
    ]);
    const draft = drafts['Ledgerly → Hana Kuroda (Riverlight Ventures)']!;
    // Maya's address is a saved Portfolio contact; Hana's needed the CRM.
    expect(draft.to).toBe('Maya Chen <maya@ledgerly.demo>');
    expect(draft.hints).toContain('No email on file for Hana Kuroda. Add it to To before sending.');
  });
});
