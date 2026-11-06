import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  canSend,
  createColoredLabel,
  deleteLabel,
  listMessageRefs,
  listOwnLabels,
  setLabelOnMessages,
  updateLabel,
  type OwnLabel,
} from '@/lib/google/gmail-send';
import { log } from '@/lib/security/redact';
import { gmailQuery, ruleSet } from '@/lib/spaces/rules';
import type {
  Integration,
  Organization,
  Space,
  SpaceHiddenItem,
  SpaceRule,
} from '@/lib/types/domain';
import { getPrimaryIntegration } from './inbox';

/**
 * Spaces in Gmail, as Fyxer does it (D-082): every Space gets a label in the
 * main mailbox, nested under one "Kraken Spaces" parent
 * ("Kraken Spaces/Athena Design"), on every message its rules match. So the
 * Space is a folder in Gmail as well as a page in Kraken.
 *
 * What it touches, and nothing else:
 * - Only labels it made itself: the parent and one label per Space, found by
 *   name. It never sets a system label, so it cannot archive, read, star,
 *   trash or spam anything, and never touches another label.
 * - Only the main mailbox, and only with the send grant (gmail.modify). A
 *   member's own Google is read-only (D-081) and is never labelled.
 * - It keeps the label equal to the rules: matching mail gets it, mail that
 *   no longer matches (a rule removed, an email hidden from the Space) loses
 *   it. Renaming a Space renames its label; deleting a Space removes the
 *   label from Gmail (the mail itself stays where it is).
 *
 * It runs after a Space is made or edited, when its page is opened (at most
 * every ten minutes), and every half hour from the push job, so new mail is
 * filed without anyone opening Kraken. Never in the demo.
 */

export const SPACES_PARENT_LABEL = 'Kraken Spaces';
/** Gmail palette green (lib/email/label-colors.ts), Kraken's emerald. */
export const SPACE_LABEL_COLOR = { bg: '#16a766', fg: '#ffffff' } as const;
/** Messages read per side per run; the newest are labelled first. */
export const SPACE_LABEL_MAX = 5_000;
const THROTTLE_MS = 10 * 60_000;

/** Whether the main mailbox may carry Space labels (it has the send grant). */
export function spaceLabelsEnabled(primary: Integration | null): boolean {
  return canSend(primary);
}

/** The Space's label in Gmail. A "/" in the name would nest a level, so it becomes "-". */
export function spaceLabelName(spaceName: string): string {
  const clean = spaceName
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${SPACES_PARENT_LABEL}/${clean || 'Space'}`;
}

export interface SpaceLabelResult {
  state: 'ok' | 'demo' | 'not_connected' | 'no_grant' | 'error' | 'skipped';
  label: string;
  added: number;
  removed: number;
  /** Messages matching the rules (up to the cap). */
  matching: number;
  capped: boolean;
  message?: string;
}

export interface SpaceLabelInput {
  space: Pick<Space, 'id' | 'name' | 'organization_id'>;
  rules: Pick<SpaceRule, 'kind' | 'value'>[];
  hidden: Pick<SpaceHiddenItem, 'item_kind' | 'item_id'>[];
}

const byName = (labels: OwnLabel[], name: string) =>
  labels.find((l) => l.name.toLowerCase() === name.toLowerCase()) ?? null;

const lastRun = new Map<string, number>();
const running = new Map<string, Promise<SpaceLabelResult>>();

/** For the tests. */
export function resetSpaceLabelThrottle(): void {
  lastRun.clear();
  running.clear();
}

/**
 * Bring one Space's Gmail label up to date. `previousName` (from an edit)
 * renames the old label instead of making a second one. `force` skips the
 * ten-minute throttle (after an edit). One run per Space at a time.
 */
export async function syncSpaceLabel(
  store: DataStore,
  input: SpaceLabelInput,
  options: {
    previousName?: string | null;
    force?: boolean;
    integration?: Integration | null;
    now?: Date;
  } = {},
): Promise<SpaceLabelResult> {
  const label = spaceLabelName(input.space.name);
  const empty = { label, added: 0, removed: 0, matching: 0, capped: false };
  if (isDemoMode()) return { ...empty, state: 'demo' };
  const key = input.space.id;
  const now = (options.now ?? new Date()).getTime();
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  if (!options.force && now - (lastRun.get(key) ?? 0) < THROTTLE_MS) {
    return { ...empty, state: 'skipped' };
  }
  const run = (async () => {
    try {
      return await syncNow(store, input, label, options);
    } catch (error) {
      log.warn('Space label sync failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        ...empty,
        state: 'error' as const,
        message: 'Gmail could not be labelled just now.',
      };
    } finally {
      lastRun.set(key, now);
      running.delete(key);
    }
  })();
  running.set(key, run);
  return run;
}

async function syncNow(
  store: DataStore,
  input: SpaceLabelInput,
  label: string,
  options: { previousName?: string | null; integration?: Integration | null },
): Promise<SpaceLabelResult> {
  const empty = { label, added: 0, removed: 0, matching: 0, capped: false };
  const primary =
    options.integration !== undefined
      ? options.integration
      : await getPrimaryIntegration(store, input.space.organization_id).catch(() => null);
  if (!primary) return { ...empty, state: 'not_connected' };
  if (!canSend(primary)) {
    return {
      ...empty,
      state: 'no_grant',
      message:
        'Turn on sending for the main mailbox (Settings → Integrations) to label Spaces in Gmail.',
    };
  }
  const labels = await listOwnLabels(store, primary);
  if (!labels.ok) return { ...empty, state: 'error', message: labels.error.message };

  if (!byName(labels.value, SPACES_PARENT_LABEL)) {
    const parent = await createColoredLabel(store, primary, SPACES_PARENT_LABEL, SPACE_LABEL_COLOR);
    if (!parent.ok) return { ...empty, state: 'error', message: parent.error.message };
  }
  let mine = byName(labels.value, label);
  if (!mine && options.previousName) {
    const old = byName(labels.value, spaceLabelName(options.previousName));
    if (old) {
      const renamed = await updateLabel(store, primary, old.id, { name: label });
      if (renamed.ok) mine = renamed.value;
    }
  }
  if (!mine) {
    const made = await createColoredLabel(store, primary, label, SPACE_LABEL_COLOR);
    if (!made.ok) return { ...empty, state: 'error', message: made.error.message };
    mine = made.value;
  }

  const q = gmailQuery(ruleSet(input.rules as SpaceRule[]));
  const hiddenThreads = new Set(
    input.hidden.filter((h) => h.item_kind === 'email').map((h) => h.item_id),
  );
  let matches: { id: string; threadId: string }[] = [];
  let capped = false;
  if (q) {
    const found = await listMessageRefs(store, primary, { q }, SPACE_LABEL_MAX);
    if (!found.ok) return { ...empty, state: 'error', message: found.error.message };
    matches = found.value.refs.filter((r) => !hiddenThreads.has(r.threadId));
    capped = found.value.capped;
  }
  const labelled = await listMessageRefs(store, primary, { labelId: mine.id }, SPACE_LABEL_MAX * 2);
  if (!labelled.ok) return { ...empty, state: 'error', message: labelled.error.message };

  const want = new Set(matches.map((m) => m.id));
  const have = new Set(labelled.value.refs.map((m) => m.id));
  const toAdd = [...want].filter((id) => !have.has(id));
  // With the search capped, older labelled mail may still match: only take
  // the label off what is hidden, or everything when the rules are gone.
  const toRemove = labelled.value.refs
    .filter((m) => (capped ? hiddenThreads.has(m.threadId) : !want.has(m.id)))
    .map((m) => m.id);

  const added = toAdd.length
    ? await setLabelOnMessages(store, primary, mine.id, toAdd, true)
    : null;
  if (added && !added.ok) return { ...empty, state: 'error', message: added.error.message };
  const removed = toRemove.length
    ? await setLabelOnMessages(store, primary, mine.id, toRemove, false)
    : null;
  if (removed && !removed.ok) return { ...empty, state: 'error', message: removed.error.message };
  return {
    state: 'ok',
    label: mine.name,
    added: added?.value ?? 0,
    removed: removed?.value ?? 0,
    matching: matches.length,
    capped,
  };
}

/**
 * A deleted Space's label comes out of Gmail (labels.delete takes it off
 * every message; the mail stays where else it is filed). Only a label under
 * "Kraken Spaces/", found by the Space's name. Never in the demo.
 */
export async function removeSpaceLabel(
  store: DataStore,
  organizationId: string,
  spaceName: string,
): Promise<boolean> {
  if (isDemoMode()) return false;
  const primary = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!primary || !canSend(primary)) return false;
  const labels = await listOwnLabels(store, primary);
  if (!labels.ok) return false;
  const name = spaceLabelName(spaceName);
  const mine = byName(labels.value, name);
  if (!mine || !mine.name.startsWith(`${SPACES_PARENT_LABEL}/`)) return false;
  const res = await deleteLabel(store, primary, mine.id);
  return res.ok;
}

/** Load one Space's rules and hidden items, for a sync outside a viewer's request. */
export async function spaceLabelInput(
  store: DataStore,
  space: Pick<Space, 'id' | 'name' | 'organization_id'>,
): Promise<SpaceLabelInput> {
  const org = space.organization_id;
  const [rules, hidden] = await Promise.all([
    store.list('space_rules', org, { eq: { space_id: space.id } }) as Promise<SpaceRule[]>,
    store.list('space_hidden_items', org, { eq: { space_id: space.id } }) as Promise<
      SpaceHiddenItem[]
    >,
  ]);
  return { space, rules, hidden };
}

/**
 * Every Space of every organization, from the push job every half hour, so
 * new mail is filed in Gmail without anyone opening Kraken. One Space at a
 * time; a Space synced in the last ten minutes is skipped. Never throws.
 */
export async function syncSpaceLabelsForAll(
  store: DataStore,
  now: Date = new Date(),
): Promise<{ spaces: number; added: number; removed: number }> {
  const total = { spaces: 0, added: 0, removed: 0 };
  if (isDemoMode()) return total;
  const organizations = (await store.list('organizations', '', {})) as Organization[];
  for (const org of organizations) {
    let spaces: Space[];
    try {
      spaces = (await store.list('spaces', org.id, {})) as Space[];
    } catch (error) {
      if (isMissingTableError(error)) continue;
      throw error;
    }
    const live = spaces.filter((s) => !s.archived_at);
    if (!live.length) continue;
    const primary = await getPrimaryIntegration(store, org.id).catch(() => null);
    if (!primary || !canSend(primary)) continue;
    for (const space of live) {
      const input = await spaceLabelInput(store, space).catch(() => null);
      if (!input) continue;
      const res = await syncSpaceLabel(store, input, { integration: primary, now });
      if (res.state === 'ok') {
        total.spaces += 1;
        total.added += res.added;
        total.removed += res.removed;
      }
    }
  }
  return total;
}
