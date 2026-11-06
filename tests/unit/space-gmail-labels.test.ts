import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import { err, ok } from '@/lib/util/result';

/**
 * Spaces in Gmail (D-082): each Space's label under "Kraken Spaces", kept
 * equal to its rules. Gmail is a fake here (labels and which messages carry
 * them); every address and name is fictional.
 */

let demo = false;
let labels: { id: string; name: string }[] = [];
let onLabel = new Map<string, Set<string>>();
let search: { id: string; threadId: string }[] = [];
let searchCapped = false;
const calls: string[] = [];
let nextId = 1;

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => demo };
});

vi.mock('@/lib/services/inbox', () => ({ getPrimaryIntegration: async () => PRIMARY }));

vi.mock('@/lib/google/gmail-send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/google/gmail-send')>();
  return {
    ...actual,
    listOwnLabels: async () => ok(labels.map((l) => ({ ...l }))),
    createColoredLabel: async (_s: unknown, _i: unknown, name: string) => {
      calls.push(`create:${name}`);
      const made = { id: `Label_${nextId++}`, name };
      labels.push(made);
      return ok(made);
    },
    updateLabel: async (_s: unknown, _i: unknown, id: string, patch: { name?: string }) => {
      calls.push(`rename:${id}:${patch.name}`);
      const l = labels.find((x) => x.id === id)!;
      l.name = patch.name ?? l.name;
      return ok({ ...l });
    },
    deleteLabel: async (_s: unknown, _i: unknown, id: string) => {
      calls.push(`delete:${id}`);
      labels = labels.filter((l) => l.id !== id);
      return ok(true);
    },
    listMessageRefs: async (_s: unknown, _i: unknown, by: { q: string } | { labelId: string }) => {
      if ('q' in by) return ok({ refs: search, capped: searchCapped });
      const ids = [...(onLabel.get(by.labelId) ?? [])];
      return ok({ refs: ids.map((id) => ({ id, threadId: `t-${id}` })), capped: false });
    },
    setLabelOnMessages: async (
      _s: unknown,
      integration: Integration,
      labelId: string,
      ids: string[],
      on: boolean,
    ) => {
      if (!actual.canSend(integration)) return err('forbidden', 'no grant');
      calls.push(`${on ? 'add' : 'remove'}:${labelId}:${ids.join(',')}`);
      const set = onLabel.get(labelId) ?? new Set<string>();
      for (const id of ids) on ? set.add(id) : set.delete(id);
      onLabel.set(labelId, set);
      return ok(ids.length);
    },
  };
});

let PRIMARY: Integration | null;

const BASE: Integration = {
  id: '44444444-4444-4444-8444-444444444444',
  organization_id: 'org-1',
  user_id: 'user-1',
  provider: 'google',
  kinds: ['gmail'],
  account_email: 'partner@firm.example',
  scopes: [...SEND_SCOPES],
  status: 'connected',
  status_detail: null,
  last_sync_at: null,
  last_sync_error: null,
  sync_cursor: null,
  watch_expires_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const {
  removeSpaceLabel,
  resetSpaceLabelThrottle,
  spaceLabelName,
  syncSpaceLabel,
  SPACES_PARENT_LABEL,
} = await import('@/lib/services/space-gmail-labels');

const store = {} as never;
const space = { id: 'space-1', name: 'Northwind Studio', organization_id: 'org-1' };
const rules = [{ kind: 'domain' as const, value: 'northwind.example' }];

beforeEach(() => {
  demo = false;
  labels = [{ id: 'Label_99', name: 'Clients' }];
  onLabel = new Map();
  search = [
    { id: 'm1', threadId: 't-m1' },
    { id: 'm2', threadId: 't-m2' },
    { id: 'm3', threadId: 't-hidden' },
  ];
  searchCapped = false;
  calls.length = 0;
  nextId = 1;
  PRIMARY = { ...BASE };
  resetSpaceLabelThrottle();
});

describe('Space labels in Gmail', () => {
  it('names the label under the parent, a slash never nesting a level', () => {
    expect(spaceLabelName('Northwind Studio')).toBe('Kraken Spaces/Northwind Studio');
    expect(spaceLabelName('  A/B  Labs ')).toBe('Kraken Spaces/A-B Labs');
    expect(spaceLabelName('')).toBe('Kraken Spaces/Space');
  });

  it('makes the parent and the Space label, and labels what matches except hidden mail', async () => {
    const res = await syncSpaceLabel(store, {
      space,
      rules,
      hidden: [{ item_kind: 'email', item_id: 't-hidden' }],
    });
    expect(res).toMatchObject({ state: 'ok', added: 2, removed: 0, matching: 2 });
    expect(calls).toEqual([
      `create:${SPACES_PARENT_LABEL}`,
      'create:Kraken Spaces/Northwind Studio',
      'add:Label_2:m1,m2',
    ]);
    // Another label of the person's is never touched.
    expect(labels.find((l) => l.id === 'Label_99')!.name).toBe('Clients');
  });

  it('is idempotent, and takes the label off mail that stops matching', async () => {
    await syncSpaceLabel(store, { space, rules, hidden: [] });
    calls.length = 0;
    search = [{ id: 'm1', threadId: 't-m1' }];
    const res = await syncSpaceLabel(store, { space, rules, hidden: [] }, { force: true });
    expect(res).toMatchObject({ state: 'ok', added: 0, removed: 2 });
    expect(calls).toEqual(['remove:Label_2:m2,m3']);
  });

  it('with the search capped, only hidden mail loses the label', async () => {
    await syncSpaceLabel(store, { space, rules, hidden: [] });
    calls.length = 0;
    search = [{ id: 'm1', threadId: 't-m1' }];
    searchCapped = true;
    const res = await syncSpaceLabel(
      store,
      { space, rules, hidden: [{ item_kind: 'email', item_id: 't-m3' }] },
      { force: true },
    );
    expect(res.removed).toBe(1);
    expect(calls).toEqual(['remove:Label_2:m3']);
  });

  it('renames the old label when the Space is renamed, never a second one', async () => {
    await syncSpaceLabel(store, { space, rules, hidden: [] });
    calls.length = 0;
    const res = await syncSpaceLabel(
      store,
      { space: { ...space, name: 'Northwind' }, rules, hidden: [] },
      { force: true, previousName: 'Northwind Studio' },
    );
    expect(res.label).toBe('Kraken Spaces/Northwind');
    expect(calls).toEqual(['rename:Label_2:Kraken Spaces/Northwind']);
  });

  it('waits ten minutes between runs unless forced', async () => {
    const now = new Date('2026-11-06T10:00:00Z');
    await syncSpaceLabel(store, { space, rules, hidden: [] }, { now });
    const again = await syncSpaceLabel(
      store,
      { space, rules, hidden: [] },
      { now: new Date('2026-11-06T10:05:00Z') },
    );
    expect(again.state).toBe('skipped');
    const later = await syncSpaceLabel(
      store,
      { space, rules, hidden: [] },
      { now: new Date('2026-11-06T10:11:00Z') },
    );
    expect(later.state).toBe('ok');
  });

  it('writes nothing without the send grant, without a mailbox, or in the demo', async () => {
    PRIMARY = { ...BASE, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] };
    expect((await syncSpaceLabel(store, { space, rules, hidden: [] })).state).toBe('no_grant');
    PRIMARY = null;
    resetSpaceLabelThrottle();
    expect((await syncSpaceLabel(store, { space, rules, hidden: [] })).state).toBe('not_connected');
    PRIMARY = { ...BASE };
    demo = true;
    resetSpaceLabelThrottle();
    expect((await syncSpaceLabel(store, { space, rules, hidden: [] })).state).toBe('demo');
    expect(calls).toEqual([]);
  });

  it('removes only the deleted Space’s own label', async () => {
    await syncSpaceLabel(store, { space, rules, hidden: [] });
    calls.length = 0;
    expect(await removeSpaceLabel(store, 'org-1', 'Clients')).toBe(false);
    expect(await removeSpaceLabel(store, 'org-1', 'Northwind Studio')).toBe(true);
    expect(calls).toEqual(['delete:Label_2']);
    expect(labels.map((l) => l.name)).toEqual(['Clients', SPACES_PARENT_LABEL]);
  });
});
