import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { companyNamesOf, foundersByCompany, roleOf } from '@/lib/crm/founders';
import {
  countPipeline,
  filterPipeline,
  mergePipeline,
  type PipelineDealInput,
  type PipelineEntryInput,
} from '@/lib/crm/pipeline-merge';
import {
  affinityDealStageKey,
  affinityLpStage,
  isFundIiField,
  isMoneyField,
  likelihoodField,
  stageWords,
} from '@/lib/crm/stage-map';
import type { DataStore } from '@/lib/db/store';
import type { CrmField } from '@/lib/types/domain';
import { demoCrmId, DEMO_IDS } from '@/lib/demo/ids';
import { isCrmNotSetUp } from '@/lib/services/crm';
import { entriesFor } from '@/lib/services/crm-destinations';
import {
  affinityDealRows,
  affinityForCompany,
  listAffinityNotes,
  listCrmPeople,
  lpStageCounts,
  portfolioFounders,
  readDestinationRows,
} from '@/lib/services/crm-pages';
import { DEFAULT_DEAL_STAGES } from '@/lib/types/domain';

/**
 * Affinity's data on the pages that use it: its stage labels read as
 * Copilot's stages, its deal lists merged with Copilot's deals, founders
 * matched to portfolio companies, and the services those pages read. Every
 * name, domain and label below is invented.
 */

/* --------------------------------------------------------------- stage map */

describe('reading Affinity stage labels', () => {
  it('drops the numbering and punctuation', () => {
    expect(stageWords('7.1 Passed - After Call')).toBe(' passed after call ');
    expect(stageWords('10. Won / Signed')).toBe(' won signed ');
    expect(stageWords('0. Identified / Vetted')).toBe(' identified vetted ');
  });

  it.each([
    ['1. New Lead', 'new'],
    ['2. Intro Call', 'founder_meeting'],
    ['3. First Meeting', 'founder_meeting'],
    ['4. Partner Meeting', 'ic_review'],
    ['5. Due Diligence', 'diligence'],
    ['6. Term Sheet', 'ic_review'],
    ['7. Waiting on Info', 'waiting_for_info'],
    ['8.1 Passed', 'passed'],
    ['7.1 Passed - After Call', 'passed'],
    ['Closed Lost', 'passed'],
    ['9. Monitoring', 'monitoring'],
    ['10. Won / Signed', 'invested'],
    ['Screening', 'reviewing'],
  ])('reads deal stage %s as %s', (label, key) => {
    expect(affinityDealStageKey(label)).toBe(key);
  });

  it('says null for a label it cannot read, and for one the workspace lacks', () => {
    expect(affinityDealStageKey('Zebra')).toBeNull();
    expect(affinityDealStageKey('')).toBeNull();
    expect(affinityDealStageKey(null)).toBeNull();
    const noDiligence = DEFAULT_DEAL_STAGES.filter((s) => s.key !== 'diligence');
    expect(affinityDealStageKey('5. Due Diligence', noDiligence)).toBeNull();
    expect(affinityDealStageKey('5. Due Diligence', DEFAULT_DEAL_STAGES)).toBe('diligence');
  });

  it.each([
    ['0. Identified / Vetted', 'target'],
    ['1. Contacted', 'contacted'],
    ['2. Meeting Held', 'meeting'],
    ['3. Materials Sent', 'materials'],
    ['4. Soft Commit', 'soft_commit'],
    ['Soft Circle', 'soft_commit'],
    ['5. Committed', 'committed'],
    ['6. Passed', 'passed'],
    ['Declined', 'passed'],
    ['Prospect', 'target'],
  ])('reads LP stage %s as %s', (label, stage) => {
    expect(affinityLpStage(label)).toBe(stage);
  });

  it('knows money columns by type or name', () => {
    expect(isMoneyField({ type: 'money', name: 'Anything' })).toBe(true);
    expect(isMoneyField({ type: 'number', name: 'Expected Amount' })).toBe(true);
    expect(isMoneyField({ type: 'text', name: 'Commitment' })).toBe(true);
    expect(isMoneyField({ type: 'status', name: 'Likelihood' })).toBe(false);
    expect(isMoneyField({ type: 'date', name: 'Last Contact' })).toBe(false);
    expect(isMoneyField({ type: 'company', name: 'Organization' })).toBe(false);
    expect(isMoneyField({ type: 'text', name: 'Intro Source' })).toBe(false);
  });

  it.each([
    // A currency sign anywhere: `\b$\b` never matched these.
    'Commit ($)',
    'Size ($K)',
    '$ Committed',
    'Committed $',
    'Interest $',
    'Ticket (€)',
    // Plain-number columns whose name is the only clue.
    'Commit',
    'Commit Size',
    'Expected Commit',
    'Soft Circle',
    'Soft circled',
    'Pledge',
    'LP Size',
    'Target Size',
    'Net Worth',
    'AUM',
    'Investable Assets',
    'Check Size',
    'Allocation',
  ])('reads %s as money', (name) => {
    expect(isMoneyField({ type: 'number', name })).toBe(true);
  });

  it('lets Fund II show only who, what kind, how likely and when, never a number', () => {
    const shown = (type: CrmField['type'], name: string) => isFundIiField({ type, name });
    expect(shown('status', 'Likelihood')).toBe(true);
    expect(shown('number', 'Probability')).toBe(true);
    expect(shown('company', 'Organization')).toBe(true);
    expect(shown('status', 'LP Type')).toBe(true);
    expect(shown('date', 'Last Contact')).toBe(true);
    expect(shown('text', 'Intro Source')).toBe(true);
    // Numbers stay off whatever they are called; so does anything unexpected.
    expect(shown('number', 'Target')).toBe(false);
    expect(shown('number', 'Score')).toBe(false);
    expect(shown('text', 'Notes')).toBe(false);
    expect(shown('text', 'Commit Type')).toBe(false);
    expect(shown('money', 'Organization Commitment')).toBe(false);
    expect(shown('number', 'Size ($K)')).toBe(false);
  });

  it('finds the likelihood column', () => {
    expect(
      likelihoodField([{ name: 'Status' }, { name: 'Close Probability' }, { name: 'Likelihood' }])
        ?.name,
    ).toBe('Close Probability');
    expect(likelihoodField([{ name: 'Status' }])).toBeNull();
  });
});

/* ---------------------------------------------------------- pipeline merge */

const T = (d: number) => new Date(Date.UTC(2026, 8, d)).toISOString();

const deal = (
  id: string,
  name: string,
  domain: string | null,
  stage: string,
  day: number,
): PipelineDealInput => ({
  id,
  company_name: name,
  domain,
  stage,
  received_at: T(day),
  updated_at: T(day),
});

const affinityRow = (
  entryId: string,
  title: string,
  status: string | null,
  day: number,
  record: { id: string; name: string; domain: string | null } | null = null,
): PipelineEntryInput => ({
  entryId,
  listId: 'list-1',
  listName: 'Example Deal List',
  title,
  recordId: record?.id ?? null,
  recordName: record?.name ?? null,
  domain: record?.domain ?? null,
  status,
  updatedAt: T(day),
});

describe('merging the pipeline', () => {
  const deals = [
    deal('d1', 'Acme Robotics Inc.', 'https://www.acme-robotics.example/', 'new', 2),
    deal('d2', 'Brightloom', null, 'diligence', 3),
  ];

  it('puts a Copilot deal and its Affinity entries on one row, by domain then name', () => {
    const rows = mergePipeline(
      deals,
      [
        affinityRow('e1', 'Acme Robotics — Seed', '3. First Meeting', 5, {
          id: 'r1',
          name: 'Acme Robotics',
          domain: 'acme-robotics.example',
        }),
        affinityRow('e2', 'Brightloom', '5. Due Diligence', 4),
        affinityRow('e3', 'Corvid Analytics', '7.1 Passed - After Call', 6, {
          id: 'r3',
          name: 'Corvid Analytics',
          domain: 'corvid.example',
        }),
        affinityRow('e4', 'Corvid Analytics extension', '1. New Lead', 1, {
          id: 'r3',
          name: 'Corvid Analytics',
          domain: 'corvid.example',
        }),
        affinityRow('e5', 'Dunmore', 'Zebra', 1),
      ],
      DEFAULT_DEAL_STAGES,
    );
    expect(rows).toHaveLength(4);
    const [acme, bright, corvid, dunmore] = rows;
    expect(acme).toMatchObject({
      deal: { id: 'd1', stageKey: 'new' },
      stageKey: 'new',
      stageSource: 'copilot',
      differs: true,
      lastActivity: T(5),
    });
    expect(acme?.affinity.map((e) => [e.entryId, e.mappedKey])).toEqual([
      ['e1', 'founder_meeting'],
    ]);
    // Same stage on both sides: not flagged.
    expect(bright).toMatchObject({ deal: { id: 'd2' }, differs: false });
    // An Affinity-only company: one row for both its entries, newest first.
    expect(corvid).toMatchObject({
      deal: null,
      name: 'Corvid Analytics',
      stageKey: 'passed',
      stageSource: 'affinity',
    });
    expect(corvid?.affinity.map((e) => e.entryId)).toEqual(['e3', 'e4']);
    // A label nothing reads: no stage, never a guess.
    expect(dunmore).toMatchObject({ stageKey: null, stageSource: null });
  });

  it('counts and filters by stage and search, newest first', () => {
    const rows = mergePipeline(
      deals,
      [
        affinityRow('e2', 'Brightloom', '5. Due Diligence', 4),
        affinityRow('e3', 'Corvid Analytics', '8.2 Passed', 6),
        affinityRow('e5', 'Dunmore', 'Zebra', 1),
      ],
      DEFAULT_DEAL_STAGES,
    );
    const counts = countPipeline(rows, DEFAULT_DEAL_STAGES);
    expect(counts).toMatchObject({
      total: 4,
      open: 3,
      other: 1,
      copilot: 1,
      affinity: 2,
      both: 1,
      byStage: { new: 1, diligence: 1, passed: 1 },
    });
    const name = (r: { name: string }) => r.name;
    expect(filterPipeline(rows, DEFAULT_DEAL_STAGES, {}).map(name)).toEqual([
      'Brightloom',
      'Acme Robotics Inc.',
      'Dunmore',
    ]);
    expect(filterPipeline(rows, DEFAULT_DEAL_STAGES, { stage: 'passed' }).map(name)).toEqual([
      'Corvid Analytics',
    ]);
    expect(filterPipeline(rows, DEFAULT_DEAL_STAGES, { stage: 'other' }).map(name)).toEqual([
      'Dunmore',
    ]);
    expect(filterPipeline(rows, DEFAULT_DEAL_STAGES, { stage: 'any' })).toHaveLength(4);
    expect(
      filterPipeline(rows, DEFAULT_DEAL_STAGES, { stage: 'any', query: 'ACME-ROB' }).map(name),
    ).toEqual(['Acme Robotics Inc.']);
  });
});

/* ----------------------------------------------------------------- founders */

describe('matching founders to portfolio companies', () => {
  const fields = [
    { key: 'company', name: 'Company', type: 'company' as const },
    { key: 'role', name: 'Role', type: 'text' as const },
    { key: 'notes', name: 'Notes', type: 'text' as const },
  ];

  it('reads company names and roles from an entry', () => {
    expect(
      companyNamesOf(fields, { company: ['Acme Robotics'], notes: 'Met at a dinner' }),
    ).toEqual(['Acme Robotics']);
    expect(roleOf(fields, { role: 'CTO' })).toBe('CTO');
    expect(roleOf(fields, {})).toBeNull();
  });

  it('matches by work email domain or company column, never by a free mail domain', () => {
    const companies = [
      { id: 'c1', name: 'Acme Robotics', domain: 'acme-robotics.example' },
      { id: 'c2', name: 'Brightloom', domain: null },
    ];
    const founders = foundersByCompany(companies, [
      {
        entryId: 'e1',
        recordId: 'p1',
        name: 'Ada Example',
        kind: 'person',
        emails: ['ada@acme-robotics.example'],
        companyNames: [],
        role: 'CEO',
      },
      {
        entryId: 'e2',
        recordId: 'p2',
        name: 'Bo Example',
        kind: 'person',
        emails: ['bo@gmail.com'],
        companyNames: ['Brightloom Inc.'],
        role: null,
      },
      {
        entryId: 'e3',
        recordId: 'p3',
        name: 'Cy Example',
        kind: 'person',
        emails: ['cy@gmail.com'],
        companyNames: [],
        role: null,
      },
      // A company-type entry is the portfolio list itself, not a founder.
      {
        entryId: 'e4',
        recordId: 'r1',
        name: 'Acme Robotics',
        kind: 'company',
        emails: [],
        companyNames: ['Acme Robotics'],
        role: null,
      },
    ]);
    expect(founders).toEqual({
      c1: [
        { entryId: 'e1', recordId: 'p1', name: 'Ada Example', role: 'CEO', matchedBy: 'domain' },
      ],
      c2: [{ entryId: 'e2', recordId: 'p2', name: 'Bo Example', role: null, matchedBy: 'name' }],
    });
  });
});

/* ----------------------------------------------------------------- services */

let harness: Harness;
let store: DataStore;
let org: string;

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
});

afterEach(async () => {
  await harness.dispose();
});

/** The demo store with every CRM table failing as missing. */
function storeWithoutCrm(inner: DataStore): DataStore {
  const failure = () =>
    Object.assign(
      new Error("[crm_lists] list failed: Could not find the table 'public.crm_lists'"),
      { code: 'PGRST205' },
    );
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('crm_')) {
          return Promise.reject(failure());
        }
        return original.apply(target, args);
      };
    },
  });
}

describe('the page services', () => {
  it('reads a whole destination with full records, and caps it', async () => {
    const all = value(await readDestinationRows(store, org, 'deals'));
    expect(all.entries).toHaveLength(15);
    expect(all.truncated).toBe(false);
    expect(all.records[demoCrmId('record', 29)]?.domain).toBe('vetrix.demo');
    const capped = value(await readDestinationRows(store, org, 'deals', { cap: 3 }));
    expect(capped.entries).toHaveLength(3);
    expect(capped.truncated).toBe(true);
  });

  it("gives Affinity's deal rows that merge with Copilot's deals", async () => {
    const rows = value(await affinityDealRows(store, org));
    const vetrix = rows.entries.find((e) => e.title === 'Vetrix');
    expect(vetrix).toMatchObject({
      listName: 'Seed Opportunities',
      domain: 'vetrix.demo',
      status: '1. New Lead',
    });
    const merged = mergePipeline(
      [
        deal(DEMO_IDS.dealVetrix, 'Vetrix', 'vetrix.demo', 'new', 1),
        deal(DEMO_IDS.dealLoomstack, 'Loomstack', 'loomstack.demo', 'passed', 1),
      ],
      rows.entries,
      DEFAULT_DEAL_STAGES,
    );
    const byName = new Map(merged.map((r) => [r.name, r]));
    expect(byName.get('Vetrix')).toMatchObject({ differs: false });
    expect(byName.get('Vetrix')?.affinity).toHaveLength(1);
    // Loomstack's Affinity record has no domain: matched by name.
    expect(byName.get('Loomstack')).toMatchObject({ differs: true });
    expect(byName.get('Loomstack')?.affinity[0]?.status).toBe('5. Due Diligence');
  });

  it("finds Affinity founders for Copilot's portfolio companies", async () => {
    const founders = await portfolioFounders(store, org, [
      { id: DEMO_IDS.pcLedgerly, name: 'Ledgerly', domain: 'ledgerly.demo' },
      { id: DEMO_IDS.pcStonebridge, name: 'Stonebridge Ops', domain: 'stonebridgeops.demo' },
    ]);
    expect(founders[DEMO_IDS.pcLedgerly]?.map((f) => [f.name, f.role])).toEqual([
      ['Maya Chen', 'CEO'],
    ]);
    expect(founders[DEMO_IDS.pcStonebridge]?.map((f) => [f.name, f.matchedBy])).toEqual([
      ['Dev Sharma', 'domain'],
    ]);
  });

  it("counts Affinity's LPs at Copilot's LP stages across lists", async () => {
    const lists = (await entriesFor(store, org, 'lps', { limit: 1 })).ok
      ? [{ id: DEMO_IDS.crmListLps }, { id: DEMO_IDS.crmListHnwi }]
      : [];
    const counts = value(await lpStageCounts(store, org, lists));
    expect(counts.total).toBe(9);
    expect(Object.fromEntries(counts.stages.map((s) => [s.key, s.count]))).toEqual({
      target: 2,
      contacted: 1,
      meeting: 1,
      // A stage some list names, with nobody at it right now.
      materials: 0,
      soft_commit: 2,
      committed: 1,
      passed: 2,
    });
    const soft = counts.stages.find((s) => s.key === 'soft_commit');
    expect(soft?.labels.sort()).toEqual(['4. Soft Commit', 'Soft Circle']);
    // The labels filter the table to exactly that stage, list by list.
    const page = value(await entriesFor(store, org, 'lps', { statusIn: soft?.labels ?? [] }));
    expect(page.entries.map((e) => e.entry.title).sort()).toEqual([
      'Celeste Varga',
      'Maren Solberg',
    ]);
  });

  it('lists people and notes a page at a time, with totals', async () => {
    const people = value(await listCrmPeople(store, org, { limit: 5 }));
    expect(people.people).toHaveLength(5);
    // 17 on lists, and the three Find & save people on none.
    expect(people.total).toBe(20);
    expect(people.people.every((p) => p.kind === 'person')).toBe(true);
    const ada = value(await listCrmPeople(store, org, { query: 'ada@brindle' }));
    expect(ada.people.map((p) => p.name)).toEqual(['Ada Brennan']);

    const notes = value(await listAffinityNotes(store, org, { limit: 3 }));
    expect(notes.total).toBe(12);
    expect(notes.notes).toHaveLength(3);
    // Newest first, and only Affinity's own notes.
    const times = notes.notes.map((n) => n.occurred_at ?? '');
    expect(times).toEqual([...times].sort().reverse());
    expect(notes.notes.every((n) => n.source === 'affinity')).toBe(true);
    expect(notes.about[notes.notes[0]!.id]?.length).toBeGreaterThan(0);
    const found = value(await listAffinityNotes(store, org, { query: 'retention' }));
    expect(found.notes.map((n) => n.title)).toEqual(['Diligence call', 'Intro call']);
  });

  it('reaches every person and note by paging, not only the first few hundred', async () => {
    const all = value(await listCrmPeople(store, org, { limit: 500 }));
    const pages = [];
    for (let offset = 0; offset < all.total; offset += 5) {
      pages.push(...value(await listCrmPeople(store, org, { limit: 5, offset })).people);
    }
    expect(pages.map((p) => p.id)).toEqual(all.people.map((p) => p.id));

    const notes = value(await listAffinityNotes(store, org, { limit: 500 }));
    const last = value(await listAffinityNotes(store, org, { limit: 5, offset: 10 }));
    expect(last.total).toBe(notes.total);
    expect(last.notes.map((n) => n.id)).toEqual(notes.notes.slice(10, 15).map((n) => n.id));
  });

  it("reads one company's Affinity side by domain, then name", async () => {
    const vetrix = await affinityForCompany(store, org, {
      name: 'Vetrix',
      domain: 'https://vetrix.demo',
    });
    expect(vetrix?.companies.map((c) => c.name)).toEqual(['Vetrix']);
    expect(vetrix?.memberships.map((m) => [m.list.name, m.status])).toEqual([
      ['Seed Opportunities', '1. New Lead'],
    ]);
    expect(vetrix?.notes.map((n) => n.title)).toEqual(['Intro call']);

    const ledgerly = await affinityForCompany(store, org, { name: 'Ledgerly', domain: null });
    expect(ledgerly?.companies.map((c) => c.name)).toEqual(['Ledgerly']);
    // Its people at the domain, and their notes.
    expect(ledgerly?.people.map((p) => p.name)).toEqual(['Maya Chen']);
    expect(ledgerly?.notes.map((n) => n.title)).toEqual(['Founder check-in']);

    expect(await affinityForCompany(store, org, { name: 'Nobody Here', domain: null })).toBeNull();
  });

  it('survives missing CRM tables', async () => {
    const missing = storeWithoutCrm(store);
    expect(isCrmNotSetUp(await readDestinationRows(missing, org, 'deals'))).toBe(true);
    expect(isCrmNotSetUp(await affinityDealRows(missing, org))).toBe(true);
    expect(isCrmNotSetUp(await listCrmPeople(missing, org))).toBe(true);
    expect(isCrmNotSetUp(await listAffinityNotes(missing, org))).toBe(true);
    expect(isCrmNotSetUp(await lpStageCounts(missing, org, [{ id: DEMO_IDS.crmListLps }]))).toBe(
      true,
    );
    // The profile decorations never fail: they show nothing.
    expect(await affinityForCompany(missing, org, { name: 'Vetrix', domain: 'vetrix.demo' })).toBe(
      null,
    );
    expect(
      await portfolioFounders(missing, org, [
        { id: DEMO_IDS.pcLedgerly, name: 'Ledgerly', domain: 'ledgerly.demo' },
      ]),
    ).toEqual({});
  });
});
