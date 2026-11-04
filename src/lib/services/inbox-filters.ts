import 'server-only';
import type { DataStore } from '@/lib/db/store';
import {
  APPLY_EXISTING_MAX,
  buildFilterBody,
  criteriaQuery,
  existingChange,
  type FilterActions,
  type FilterCriteria,
  type GmailFilter,
} from '@/lib/email/inbox-filters';
import {
  canManageFilters,
  createFilter,
  deleteFilter,
  listFilters,
} from '@/lib/google/gmail-filters';
import { listThreadPage } from '@/lib/google/gmail-inbox';
import {
  canSend,
  setThreadLabels,
  type InboxLabel,
  type UserLabelId,
} from '@/lib/google/gmail-send';
import type { MailLabel } from '@/lib/email/inbox-actions';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import {
  demoMatchingIds,
  forgetThreads,
  readLabelChoices,
  setDemoSystemLabels,
  setDemoThreadLabels,
} from './inbox-live';

/**
 * The Inbox's Create filter and Filters list. A filter is made only when a
 * person clicks Create in the dialog, and deleted only when they click
 * Delete in the list: nothing here runs on its own, from a schedule, a
 * routine or an AI tool. Needs the opt-in "Turn on filters" grant. The demo
 * keeps its filters in this process alone; nothing reaches Gmail.
 *
 * "Also apply to matching conversations" uses the Inbox's own label path
 * (setThreadLabels: inbox, read state, star, important, the person's own
 * labels), at most APPLY_EXISTING_MAX conversations, never TRASH.
 */

export type FilterState = 'on' | 'off' | 'demo' | 'not_connected';

export interface FilterAccess {
  state: FilterState;
  /** "Also apply to matching conversations" can run: sending is on, or the demo. */
  canApplyExisting: boolean;
}

export function filterAccess(demo: boolean, integration: Integration | null): FilterAccess {
  if (demo) return { state: 'demo', canApplyExisting: true };
  if (!integration || integration.status === 'disconnected') {
    return { state: 'not_connected', canApplyExisting: false };
  }
  return {
    state: canManageFilters(integration) ? 'on' : 'off',
    canApplyExisting: canSend(integration),
  };
}

const demoFilters = processWide('inbox-filters-demo', () => ({
  list: [] as GmailFilter[],
  seq: 0,
}));

/** Test hook. */
export function resetDemoFilters(): void {
  demoFilters.list = [];
  demoFilters.seq = 0;
}

export async function readFilters(
  store: DataStore,
  demo: boolean,
  integration: Integration | null,
): Promise<Result<{ filters: GmailFilter[]; labels: MailLabel[] }>> {
  if (demo) {
    return ok({ filters: [...demoFilters.list], labels: await readLabelChoices(store, null) });
  }
  if (!integration || !canManageFilters(integration)) {
    return err('forbidden', 'Filters are off. Turn on filters first.');
  }
  const [filters, labels] = await Promise.all([
    listFilters(store, integration),
    readLabelChoices(store, integration),
  ]);
  if (!filters.ok) return filters;
  return ok({ filters: filters.value, labels });
}

export interface MakeFilterInput {
  criteria: FilterCriteria;
  actions: FilterActions;
  applyExisting: boolean;
}

export async function makeFilter(
  store: DataStore,
  organizationId: string,
  demo: boolean,
  integration: Integration | null,
  input: MakeFilterInput,
): Promise<Result<{ filter: GmailFilter; applied: number }>> {
  const built = buildFilterBody(input.criteria, input.actions);
  if (!built.ok) return err('invalid_input', built.message);
  if (!demo && (!integration || !canManageFilters(integration))) {
    return err('forbidden', 'Filters are off. Turn on filters first.');
  }
  // "Apply the label": only one of the person's own labels.
  if (input.actions.label) {
    const labels = await readLabelChoices(store, demo ? null : integration, { fresh: !demo });
    if (!labels.some((l) => l.id === input.actions.label)) {
      return err('invalid_input', 'Pick one of your labels.');
    }
  }

  let filter: GmailFilter;
  if (demo) {
    filter = { id: `demo-filter-${++demoFilters.seq}`, ...built.body };
    demoFilters.list = [...demoFilters.list, filter];
  } else {
    const made = await createFilter(store, integration!, built.body);
    if (!made.ok) return made;
    filter = made.value;
  }

  let applied = 0;
  const change = existingChange(input.actions);
  if (input.applyExisting && (change.add.length || change.remove.length)) {
    applied = demo
      ? await applyDemo(store, organizationId, input.criteria, change)
      : await applyLive(store, integration!, input.criteria, change);
  }
  return ok({ filter, applied });
}

async function applyLive(
  store: DataStore,
  integration: Integration,
  criteria: FilterCriteria,
  change: { add: string[]; remove: string[] },
): Promise<number> {
  if (!canSend(integration)) return 0;
  const page = await listThreadPage(store, integration, {
    q: criteriaQuery(criteria),
    max: APPLY_EXISTING_MAX,
  });
  if (!page.ok) return 0;
  const ids = page.value.threads.map((t) => t.id).slice(0, APPLY_EXISTING_MAX);
  const typed = {
    add: change.add as (InboxLabel | UserLabelId)[],
    remove: change.remove as (InboxLabel | UserLabelId)[],
  };
  let done = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const results = await Promise.all(
      batch.map((id) => setThreadLabels(store, integration, id, typed)),
    );
    done += results.filter((r) => r.ok).length;
  }
  forgetThreads(ids);
  return done;
}

async function applyDemo(
  store: DataStore,
  organizationId: string,
  criteria: FilterCriteria,
  change: { add: string[]; remove: string[] },
): Promise<number> {
  const ids = await demoMatchingIds(
    store,
    organizationId,
    criteriaQuery(criteria),
    APPLY_EXISTING_MAX,
  );
  const isUser = (l: string) => l.startsWith('Label_');
  const user = { add: change.add.filter(isUser), remove: change.remove.filter(isUser) };
  const system = {
    add: change.add.filter((l) => !isUser(l)),
    remove: change.remove.filter((l) => !isUser(l)),
  };
  let done = 0;
  for (const id of ids) {
    let res: { ok: boolean } = { ok: true };
    if (user.add.length || user.remove.length) {
      res = await setDemoThreadLabels(store, organizationId, id, user);
    }
    if (system.add.length || system.remove.length) {
      res = await setDemoSystemLabels(store, organizationId, id, system);
    }
    if (res.ok) done++;
  }
  return done;
}

export async function removeFilter(
  store: DataStore,
  demo: boolean,
  integration: Integration | null,
  id: string,
): Promise<Result<true>> {
  if (demo) {
    const before = demoFilters.list.length;
    demoFilters.list = demoFilters.list.filter((f) => f.id !== id);
    return demoFilters.list.length < before ? ok(true) : err('not_found', 'That filter is gone.');
  }
  if (!integration || !canManageFilters(integration)) {
    return err('forbidden', 'Filters are off. Turn on filters first.');
  }
  return deleteFilter(store, integration, id);
}

/**
 * How many conversations a filter's search matches now, for "Also apply
 * filter to N matching conversations": one Gmail list of a single result
 * (its estimate), or the demo's own count. Null when unknown.
 */
export async function countMatching(
  store: DataStore,
  organizationId: string,
  demo: boolean,
  integration: Integration | null,
  criteria: FilterCriteria,
): Promise<number | null> {
  const q = criteriaQuery(criteria);
  if (!q) return 0;
  if (demo) return (await demoMatchingIds(store, organizationId, q, 1000)).length;
  if (!integration) return null;
  const page = await listThreadPage(store, integration, { q, max: 1 });
  return page.ok ? (page.value.total ?? page.value.threads.length) : null;
}
