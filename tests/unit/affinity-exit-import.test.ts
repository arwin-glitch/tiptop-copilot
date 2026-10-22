import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeLiveTeam } from '../helpers/live-team';
import {
  estimateMegabytes,
  isOpenReminder,
  reminderTask,
  unlistedCompanyRow,
  unlistedPersonRow,
  type AffinityApiReminder,
} from '@/lib/crm/affinity-exit-import';
import type { DataStore } from '@/lib/db/store';
import { DEMO_TEAMMATE } from '@/lib/demo/fixtures';
import {
  AFFINITY_EXIT_IMPORT_ACTION,
  readAffinityExitImports,
  reminderTaskId,
  runAffinityExitImportStep,
  type AffinityExitImportKind,
  type AffinityExitImportOptions,
  type AffinityExitImportStep,
} from '@/lib/services/affinity-exit-import';
import type { CrmRecord, Task } from '@/lib/types/domain';

/**
 * The exit checklist's opt-in copies, against a fake Affinity: an invented
 * directory of companies and people and a handful of reminders, paged the way
 * the v2 API pages them, through a mocked fetch. The CRM and the tasks are
 * the real services on the demo store.
 */

const KEY = 'test-affinity-key-not-a-real-one-0000';
const ORIGIN = 'https://api.affinity.co';

interface Directory {
  companies: unknown[];
  persons: unknown[];
  reminders: AffinityApiReminder[];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeAffinity(world: Directory, pageSize = 2) {
  const calls: string[] = [];
  let refuse: number | null = null;
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error(`request left Affinity: ${url.origin}`);
    calls.push(url.pathname + url.search);
    if (refuse) return json({ message: 'Refused' }, refuse);
    const items =
      url.pathname === '/v2/companies'
        ? world.companies
        : url.pathname === '/v2/persons'
          ? world.persons
          : url.pathname === '/v2/reminders'
            ? world.reminders
            : null;
    if (!items) return json({ message: 'not found' }, 404);
    if (url.searchParams.get('totalCount') === 'true') {
      const open = world.reminders.filter(
        (r) => r.status === 'active' || r.status === 'overdue',
      ).length;
      return json({ data: items.slice(0, 1), pagination: { nextUrl: null, totalCount: open } });
    }
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const next = offset + pageSize;
    return json({
      data: items.slice(offset, next),
      pagination: {
        prevUrl: null,
        nextUrl: next < items.length ? `${ORIGIN}${url.pathname}?cursor=${next}` : null,
      },
    });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    refuse: (status: number | null) => {
      refuse = status;
    },
  };
}

const company = (id: number, name: string, domain: string | null, domains: string[] = []) => ({
  id,
  name,
  domain,
  domains,
  isGlobal: false,
});
const person = (
  id: number,
  first: string,
  last: string | null,
  email: string | null,
  type = 'external',
) => ({
  id,
  firstName: first,
  lastName: last,
  primaryEmailAddress: email,
  emailAddresses: email ? [email] : [],
  type,
});

function directory(): Directory {
  return {
    companies: [
      // Already in Copilot from a list (the demo's first Affinity company).
      company(310_000, 'A different name from the directory', 'other.example'),
      company(880_001, 'Fernhollow Analytics', 'fernhollow.example'),
      company(880_002, 'Marrowgate Labs', null, ['marrowgate.example']),
      company(880_003, '   ', 'nameless.example'),
      company(880_004, 'Tidewell Robotics', 'tidewell.example'),
    ],
    persons: [
      person(990_001, 'Juno', 'Brightwater', 'juno@fernhollow.example'),
      person(990_002, 'Sam', 'Teammate', 'sam@fund.example', 'internal'),
      person(990_003, 'Ola', null, null),
    ],
    reminders: [
      {
        id: 4001,
        type: 'one-time',
        status: 'active',
        content: 'Send the follow-up deck',
        dueDate: '2030-04-02T15:00:00Z',
        company: { id: 880_001 },
        person: null,
        opportunity: null,
        recurrence: null,
      },
      {
        id: 4002,
        type: 'one-time',
        status: 'completed',
        content: 'Already done',
        dueDate: '2030-01-02T15:00:00Z',
        recurrence: null,
      },
      {
        id: 4003,
        type: 'recurring',
        status: 'overdue',
        content: null,
        dueDate: '2030-03-20T15:00:00Z',
        person: { id: 990_001 },
        recurrence: { resetTrigger: 'interaction', periodDays: 90 },
      },
    ],
  };
}

let harness: Harness;
let store: DataStore;
let org: string;
let clock: number;

beforeEach(async () => {
  harness = await createHarness();
  store = harness.store;
  org = harness.auth.organizationId;
  clock = Date.parse('2030-03-01T15:00:00Z');
});

afterEach(async () => {
  await harness.dispose();
});

function options(
  fake: ReturnType<typeof fakeAffinity>,
  extra: Partial<AffinityExitImportOptions> = {},
): AffinityExitImportOptions {
  return {
    apiKey: KEY,
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    userId: harness.auth.userId,
    ...extra,
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Press the button: steps until done or capped, the first one fresh, as the page does. */
async function press(
  kind: AffinityExitImportKind,
  fake: ReturnType<typeof fakeAffinity>,
  extra: Partial<AffinityExitImportOptions> = {},
) {
  let last: AffinityExitImportStep | null = null;
  for (let i = 0; i < 50; i++) {
    last = value(
      await runAffinityExitImportStep(
        store,
        org,
        kind,
        options(fake, { ...extra, fresh: i === 0 }),
      ),
    );
    clock += 1000;
    if (last.done || last.capped) return last;
  }
  throw new Error('the copy never finished');
}

const affinityRecord = (kind: 'company' | 'person', externalId: string) =>
  store.findOne('crm_records', org, {
    eq: { kind, source: 'affinity', external_id: externalId },
  }) as Promise<CrmRecord | null>;

describe('mapping the directory and reminders', () => {
  it('keeps a company with a name, its domain or first listed domain', () => {
    expect(unlistedCompanyRow(company(1, 'Fernhollow', 'www.fernhollow.example'))).toEqual({
      externalId: '1',
      name: 'Fernhollow',
      domain: 'fernhollow.example',
    });
    expect(unlistedCompanyRow(company(2, 'Marrowgate', null, ['marrowgate.example']))?.domain).toBe(
      'marrowgate.example',
    );
    expect(unlistedCompanyRow(company(3, ' ', 'x.example'))).toBeNull();
  });

  it('never makes a teammate a contact, and needs a name or an address', () => {
    expect(
      unlistedPersonRow(person(1, 'Sam', 'Teammate', 'sam@fund.example', 'internal')),
    ).toBeNull();
    expect(unlistedPersonRow(person(2, 'Juno', 'Brightwater', 'juno@fernhollow.example'))).toEqual({
      externalId: '2',
      name: 'Juno Brightwater',
      primaryEmail: 'juno@fernhollow.example',
      emails: ['juno@fernhollow.example'],
    });
    expect(
      unlistedPersonRow({ id: 3, firstName: '', lastName: null, primaryEmailAddress: null }),
    ).toBeNull();
  });

  it('turns an open reminder into a task, due when it is', () => {
    const [open, done, recurring] = directory().reminders;
    expect(isOpenReminder(open!)).toBe(true);
    expect(isOpenReminder(done!)).toBe(false);
    expect(reminderTask(open!, 'Fernhollow Analytics')).toEqual({
      title: 'Affinity reminder: Send the follow-up deck',
      detail: 'About Fernhollow Analytics. Copied from Affinity before it is cancelled.',
      dueAt: '2030-04-02T15:00:00.000Z',
    });
    expect(reminderTask(recurring!, 'Juno Brightwater')).toMatchObject({
      title: 'Affinity reminder: Follow up with Juno Brightwater',
      detail: 'Repeats every 90 days in Affinity. Copied from Affinity before it is cancelled.',
    });
    expect(reminderTask({ id: 9, content: 'x'.repeat(400) }, null).title).toHaveLength(300);
  });

  it('estimates what a copy costs the database', () => {
    expect(estimateMegabytes(5_000)).toBe(6);
    expect(estimateMegabytes(1)).toBe(1);
  });
});

describe('copying the contacts on no list', () => {
  it('adds the ones Copilot lacks, leaves the rest exactly as they are, and skips teammates', async () => {
    const before = await affinityRecord('company', '310000');
    const fake = fakeAffinity(directory());
    const done = await press('contacts', fake);
    expect(done).toMatchObject({ done: true, phase: 'done', scanned: 8, existing: 1, copied: 5 });
    // A nameless company, a teammate.
    expect(done.skipped).toBe(2);

    expect(await affinityRecord('company', '880001')).toMatchObject({
      name: 'Fernhollow Analytics',
      domain: 'fernhollow.example',
    });
    expect((await affinityRecord('company', '880002'))?.domain).toBe('marrowgate.example');
    expect(await affinityRecord('company', '880003')).toBeNull();
    expect(await affinityRecord('person', '990001')).toMatchObject({
      name: 'Juno Brightwater',
      primary_email: 'juno@fernhollow.example',
    });
    expect(await affinityRecord('person', '990002')).toBeNull();
    // Already in Copilot: untouched, not renamed from the directory.
    expect(await affinityRecord('company', '310000')).toEqual(before);

    // Companies first, then people, page by page.
    expect(fake.calls[0]).toBe('/v2/companies?limit=100');
    expect(fake.calls.filter((c) => c.startsWith('/v2/companies'))).toHaveLength(3);
    expect(fake.calls.filter((c) => c.startsWith('/v2/persons'))).toHaveLength(2);
  });

  it('changes nothing when pressed again', async () => {
    const fake = fakeAffinity(directory());
    await press('contacts', fake);
    const count = await store.count('crm_records', org);
    const again = await press('contacts', fake);
    expect(again).toMatchObject({ done: true, runCopied: 0, existing: 6 });
    expect(await store.count('crm_records', org)).toBe(count);
  });

  it('stops each press at its cap and carries on from there on the next', async () => {
    const fake = fakeAffinity(directory(), 1);
    // A press copies at most `perRun`, checked a page ahead (a page adds up to 100).
    const first = await press('contacts', fake, { perRun: 100, maxPages: 1 });
    expect(first).toMatchObject({ capped: true, done: false });
    const summary = (await readAffinityExitImports(store, org, new Date(clock))).contacts;
    expect(summary).toMatchObject({ state: 'partial', running: false });

    const rest = await press('contacts', fake, { maxPages: 1 });
    expect(rest).toMatchObject({ done: true, copied: 5 });
  });

  it('refuses to fill the database past its ceiling', async () => {
    const held = await store.count('crm_records', org);
    const fake = fakeAffinity(directory());
    const result = await runAffinityExitImportStep(
      store,
      org,
      'contacts',
      options(fake, { fresh: true, ceiling: held + 50 }),
    );
    expect(!result.ok && result.error.code).toBe('too_large');
    expect(fake.calls).toEqual([]);
    expect((await readAffinityExitImports(store, org)).contacts.lastError?.message).toContain(
      'Nothing more was copied',
    );
  });

  it('reports a refused key plainly, and saves no key or name in its progress', async () => {
    const fake = fakeAffinity(directory());
    fake.refuse(401);
    const result = await runAffinityExitImportStep(
      store,
      org,
      'contacts',
      options(fake, { fresh: true }),
    );
    expect(!result.ok && result.error.message).toBe(
      'Affinity refused the API key, so nothing more was copied.',
    );
    fake.refuse(null);
    await press('contacts', fake);
    const rows = await store.list('audit_events', org, {
      eq: { action: AFFINITY_EXIT_IMPORT_ACTION },
    });
    const text = JSON.stringify(rows);
    for (const secret of [KEY, 'Fernhollow', 'Juno', 'fernhollow.example']) {
      expect(text).not.toContain(secret);
    }
  });

  it('says what the key may not read when the directory is off limits', async () => {
    const fake = fakeAffinity(directory());
    fake.refuse(403);
    const result = await runAffinityExitImportStep(
      store,
      org,
      'contacts',
      options(fake, { fresh: true }),
    );
    expect(!result.ok && result.error.message).toContain('may not read the whole directory');
  });
});

describe('copying the open reminders', () => {
  it('makes one task per open reminder, named for whom it is about', async () => {
    const fake = fakeAffinity(directory());
    // The company and person are in Copilot first, so the tasks can name them.
    await press('contacts', fake);
    const done = await press('reminders', fake);
    expect(done).toMatchObject({ done: true, copied: 2, skipped: 1, openTotal: 2 });

    const deck = (await store.get('tasks', org, reminderTaskId(org, 4001))) as Task;
    expect(deck).toMatchObject({
      title: 'Affinity reminder: Send the follow-up deck',
      status: 'open',
      due_at: '2030-04-02T15:00:00.000Z',
      assigned_to: harness.auth.userId,
      source: 'suggested',
    });
    expect(deck.detail).toContain('About Fernhollow Analytics.');
    const recurring = (await store.get('tasks', org, reminderTaskId(org, 4003))) as Task;
    expect(recurring.title).toBe('Affinity reminder: Follow up with Juno Brightwater');
    expect(await store.get('tasks', org, reminderTaskId(org, 4002))).toBeNull();
    // The count asks Affinity for the open ones with a filter, once.
    expect(fake.calls.filter((c) => c.includes('totalCount=true'))).toHaveLength(1);
  });

  it('gives the tasks to the principal, whoever presses, made by who pressed', async () => {
    // The owner who set the team up presses; the mailbox, and the work, is the demo user's.
    await makeLiveTeam(store, harness.auth);
    const fake = fakeAffinity(directory());
    await press('reminders', fake, { userId: DEMO_TEAMMATE.id });
    const deck = (await store.get('tasks', org, reminderTaskId(org, 4001))) as Task;
    expect(deck).toMatchObject({
      assigned_to: harness.auth.userId,
      created_by: DEMO_TEAMMATE.id,
    });
  });

  it('never adds a reminder twice, nor brings back a task someone finished', async () => {
    const fake = fakeAffinity(directory());
    await press('reminders', fake);
    const id = reminderTaskId(org, 4001);
    await store.update('tasks', org, id, {
      status: 'complete',
      completed_at: new Date().toISOString(),
    });
    const tasks = await store.count('tasks', org);

    const again = await press('reminders', fake);
    expect(again).toMatchObject({ done: true, runCopied: 0, existing: 2 });
    expect(await store.count('tasks', org)).toBe(tasks);
    expect((await store.get('tasks', org, id))?.status).toBe('complete');
  });

  it('gives a task an id fixed by the workspace and the reminder', () => {
    expect(reminderTaskId(org, 4001)).toBe(reminderTaskId(org, 4001));
    expect(reminderTaskId(org, 4001)).not.toBe(reminderTaskId(org, 4002));
    expect(reminderTaskId(org, 4001)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('the copies’ summaries', () => {
  it('read as never pressed before anything ran, and never throw', async () => {
    const summary = await readAffinityExitImports(store, org);
    expect(summary.contacts).toMatchObject({ state: 'never', copied: 0, lastError: null });
    expect(summary.reminders).toMatchObject({ state: 'never', openTotal: null });

    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'list') return () => Promise.reject(new Error('relation does not exist'));
        return Reflect.get(target, prop, receiver);
      },
    });
    expect((await readAffinityExitImports(broken, org)).contacts.state).toBe('never');
  });

  it('wait while another press holds the copy', async () => {
    const fake = fakeAffinity(directory());
    // A press that stops after one page, then a second one at the same moment.
    value(
      await runAffinityExitImportStep(
        store,
        org,
        'contacts',
        options(fake, { fresh: true, maxPages: 1 }),
      ),
    );
    // Take the lease by hand: a step in progress elsewhere.
    const rows = await store.list('audit_events', org, {
      eq: { action: AFFINITY_EXIT_IMPORT_ACTION, entity_id: 'contacts' },
    });
    const newest = rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]!;
    await store.insert('audit_events', {
      ...newest,
      id: '00000000-0000-4000-8000-00000000e417',
      created_at: new Date(clock + 60).toISOString(),
      metadata: {
        state: {
          ...(newest.metadata.state as object),
          leaseUntil: new Date(clock + 60_000).toISOString(),
        },
      },
    });
    const busy = value(
      await runAffinityExitImportStep(store, org, 'contacts', options(fake, { fresh: false })),
    );
    expect(busy).toMatchObject({ busy: true, done: false });
  });
});
