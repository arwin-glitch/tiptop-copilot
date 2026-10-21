import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS, demoCrmId } from '@/lib/demo/ids';
import {
  readTaskCompanies,
  searchTaskCompanies,
  setTaskCompany,
  TASK_COMPANY_ACTION,
} from '@/lib/services/task-company';
import { latestHumanTaskTouch } from '@/lib/services/task-close';
import { createTask } from '@/lib/services/tasks';
import type { AuditEvent, CrmRecord, Task } from '@/lib/types/domain';

/**
 * The company chip on a task ("Send the data-room checklist (Brightkiln)"):
 * read from the links tasks already have (a deal, a portfolio
 * company) or a CRM company chosen in the edit dialog, kept as an audit row.
 * Over the demo store; every name and id here is invented.
 */

let harness: Harness;
let org: string;

beforeEach(async () => {
  harness = await createHarness();
  org = harness.auth.organizationId;
});

afterEach(async () => {
  await harness.dispose();
});

async function taskById(id: string): Promise<Task> {
  const task = (await harness.store.get('tasks', org, id)) as Task | null;
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

async function plain(title = 'ZZ Send the data-room checklist'): Promise<Task> {
  const created = await createTask(harness.auth, { title });
  if (!created.ok) throw new Error('could not create');
  return created.value;
}

/** A demo CRM company, by name. */
async function crmCompany(name: string): Promise<CrmRecord> {
  const rows = (await harness.store.list('crm_records', org, {
    eq: { kind: 'company', name_key: name.toLowerCase() },
  })) as CrmRecord[];
  if (!rows[0]) throw new Error(`no CRM company ${name}`);
  return rows[0];
}

describe('reading a task company', () => {
  it('names the linked deal or portfolio company, and nothing for an unlinked task', async () => {
    const deal = await taskById(DEMO_IDS.taskLoomstackPass);
    const portfolio = await taskById(DEMO_IDS.taskLedgerlyIntros);
    const unlinked = await plain();
    const read = await readTaskCompanies(harness.store, org, [deal, portfolio, unlinked]);
    expect(read.get(deal.id)).toMatchObject({
      kind: 'deal',
      id: DEMO_IDS.dealLoomstack,
      href: `/deals/${DEMO_IDS.dealLoomstack}`,
    });
    expect(read.get(portfolio.id)).toEqual({
      kind: 'portfolio',
      id: DEMO_IDS.pcLedgerly,
      name: 'Ledgerly',
      href: `/portfolio/${DEMO_IDS.pcLedgerly}`,
    });
    expect(read.has(unlinked.id)).toBe(false);
  });

  it('never throws: a broken store shows no chips', async () => {
    const broken = {
      ...harness.store,
      list: async () => {
        throw new Error('store down');
      },
    } as unknown as typeof harness.store;
    const read = await readTaskCompanies(broken, org, [await taskById(DEMO_IDS.taskLoomstackPass)]);
    expect(read.size).toBe(0);
  });
});

describe('choosing a company in the edit dialog', () => {
  it('links a CRM company with an audit row, and shows it', async () => {
    const task = await plain();
    const quill = await crmCompany('Quillmark');
    const set = await setTaskCompany(harness.auth, task.id, { kind: 'crm', id: quill.id });
    expect(set.ok).toBe(true);
    const fresh = await taskById(task.id);
    expect(fresh.deal_id).toBeNull();
    expect(fresh.portfolio_company_id).toBeNull();
    const read = await readTaskCompanies(harness.store, org, [fresh]);
    expect(read.get(task.id)).toEqual({
      kind: 'crm',
      id: quill.id,
      name: 'Quillmark',
      href: `/lists/records/${quill.id}`,
    });
    const audit = (await harness.store.list('audit_events', org, {
      eq: { action: TASK_COMPANY_ACTION, entity_id: task.id },
    })) as AuditEvent[];
    expect(audit[0]).toMatchObject({ user_id: harness.auth.userId });
    expect(audit[0]?.metadata).toMatchObject({ kind: 'crm', id: quill.id, name: 'Quillmark' });
  });

  it('switches to a deal or a portfolio company through the columns, and clears', async () => {
    const task = await plain();
    await setTaskCompany(harness.auth, task.id, {
      kind: 'crm',
      id: (await crmCompany('Quillmark')).id,
    });
    await setTaskCompany(harness.auth, task.id, { kind: 'deal', id: DEMO_IDS.dealGirder });
    let fresh = await taskById(task.id);
    expect(fresh).toMatchObject({ deal_id: DEMO_IDS.dealGirder, portfolio_company_id: null });
    expect((await readTaskCompanies(harness.store, org, [fresh])).get(task.id)?.kind).toBe('deal');

    await setTaskCompany(harness.auth, task.id, { kind: 'portfolio', id: DEMO_IDS.pcLedgerly });
    fresh = await taskById(task.id);
    expect(fresh).toMatchObject({ deal_id: null, portfolio_company_id: DEMO_IDS.pcLedgerly });

    await setTaskCompany(harness.auth, task.id, null);
    fresh = await taskById(task.id);
    expect(fresh).toMatchObject({ deal_id: null, portfolio_company_id: null });
    expect((await readTaskCompanies(harness.store, org, [fresh])).has(task.id)).toBe(false);
  });

  it('refuses a company that is not there, or is a person', async () => {
    const task = await plain();
    const missing = await setTaskCompany(harness.auth, task.id, {
      kind: 'deal',
      id: '0f0e0d0c-0b0a-4908-8706-050403020100',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not_found');
    const person = await setTaskCompany(harness.auth, task.id, {
      kind: 'crm',
      id: demoCrmId('record', 16),
    });
    expect(person.ok).toBe(false);
  });

  it("refuses another organization's task", async () => {
    const other = await addSecondOrganization(harness);
    const task = await plain();
    const result = await setTaskCompany(other, task.id, {
      kind: 'deal',
      id: DEMO_IDS.dealGirder,
    });
    expect(result.ok).toBe(false);
    expect((await taskById(task.id)).deal_id).toBeNull();
  });

  it('is not a touch: the task-closer can still close the task', async () => {
    const task = await plain();
    const before = await latestHumanTaskTouch(harness.store, org, task);
    await setTaskCompany(harness.auth, task.id, { kind: 'deal', id: DEMO_IDS.dealGirder });
    expect(await latestHumanTaskTouch(harness.store, org, task)).toBe(before);
  });
});

describe('searching for a company', () => {
  it('finds portfolio companies, deals and CRM companies by name', async () => {
    const ledgerly = await searchTaskCompanies(harness.store, org, 'ledg');
    // The CRM's own Ledgerly is the portfolio company: listed once.
    expect(ledgerly.filter((o) => o.name === 'Ledgerly')).toEqual([
      { kind: 'portfolio', id: DEMO_IDS.pcLedgerly, name: 'Ledgerly', sub: 'Portfolio' },
    ]);
    const girder = await searchTaskCompanies(harness.store, org, 'Girder');
    expect(girder.some((o) => o.kind === 'deal' && o.id === DEMO_IDS.dealGirder)).toBe(true);
    const quill = await searchTaskCompanies(harness.store, org, 'quillm');
    expect(quill).toEqual([
      expect.objectContaining({ kind: 'crm', name: 'Quillmark', sub: 'CRM · quillmark.example' }),
    ]);
  });

  it('needs two characters', async () => {
    expect(await searchTaskCompanies(harness.store, org, 'q')).toEqual([]);
  });
});
