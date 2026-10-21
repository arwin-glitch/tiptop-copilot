/**
 * Pure rules the live Inbox shares between its screen and its routes: what a
 * label change from a tap may do, and how a change made in the app stays on
 * screen until Gmail's own lists catch up. No I/O here, so the client can
 * draw a change at once and the route can hold it to the same rules.
 */

/** A label of the person's own in Gmail: never a system label or a category. */
export interface MailLabel {
  id: string;
  name: string;
}

/** Gmail ids a person's own labels `Label_…`; system labels and categories never look like it. */
export const USER_LABEL_ID = /^Label_[0-9A-Za-z]{1,40}$/;

/** Labels one tap may add or remove at once. */
export const MAX_LABELS_PER_CHANGE = 10;

/**
 * A numbered label: one or two digits, then a colon ("1: Reply today",
 * "4: Read later"). Sorters that file mail into a numbered family put a
 * thread back into one when it has none, so a numbered label is only ever
 * swapped for another, never taken off alone. A year ("2025: taxes") is not
 * a family: more than two digits.
 */
export function isNumberedLabel(name: string): boolean {
  return /^\s*\d{1,2}\s*:/.test(name);
}

/** The person's own labels from Gmail's id -> name map, sorted the way Gmail lists them. */
export function labelChoices(names: ReadonlyMap<string, string>): MailLabel[] {
  return [...names]
    .filter(([id, name]) => USER_LABEL_ID.test(id) && name.trim() !== '')
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export interface LabelChange {
  add: string[];
  remove: string[];
}

export type LabelPlan =
  | { ok: true; add: string[]; remove: string[] }
  | { ok: false; reason: 'unknown' | 'nothing' | 'conflict'; message: string };

/**
 * What one tap really changes. Every id must be one of the person's own
 * labels (`labels`), so no system label gets through this way. Picking a
 * numbered label is a move: the other numbered labels come off in the same
 * change, on every thread it touches. Taking a numbered label off without
 * picking another is refused: the sorter would only put one back.
 */
export function planLabelChange(labels: readonly MailLabel[], change: LabelChange): LabelPlan {
  const byId = new Map(labels.map((l) => [l.id, l]));
  const add = [...new Set(change.add)];
  const remove = [...new Set(change.remove)];
  if (add.length === 0 && remove.length === 0) {
    return { ok: false, reason: 'nothing', message: 'Pick a label first.' };
  }
  if ([...add, ...remove].some((id) => !byId.has(id))) {
    return {
      ok: false,
      reason: 'unknown',
      message: 'That label is not in Gmail any more. Refresh and try again.',
    };
  }
  if (add.some((id) => remove.includes(id))) {
    return { ok: false, reason: 'conflict', message: 'A label cannot go on and off at once.' };
  }
  const numbered = (id: string) => isNumberedLabel(byId.get(id)!.name);
  const movedTo = add.filter(numbered);
  if (movedTo.length > 1) {
    return {
      ok: false,
      reason: 'conflict',
      message: 'Pick one numbered label: a thread sits in one at a time.',
    };
  }
  if (movedTo.length === 0 && remove.some(numbered)) {
    return {
      ok: false,
      reason: 'conflict',
      message: 'A numbered label is swapped, not taken off. Pick another numbered label instead.',
    };
  }
  const family = movedTo.length
    ? labels.filter((l) => isNumberedLabel(l.name) && l.id !== movedTo[0]).map((l) => l.id)
    : [];
  return { ok: true, add, remove: [...new Set([...remove, ...family])] };
}

/** A thread's own label ids after a change, in Gmail's list order. */
export function applyLabelPlan(
  current: readonly string[],
  plan: { add: readonly string[]; remove: readonly string[] },
): string[] {
  const kept = current.filter((id) => !plan.remove.includes(id));
  return [...kept, ...plan.add.filter((id) => !kept.includes(id))];
}

/** Names for display, in label order; ids no longer in Gmail are left out. */
export function labelNamesFor(ids: readonly string[], labels: readonly MailLabel[]): string[] {
  const names = new Map(labels.map((l) => [l.id, l.name]));
  return ids.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
}

/* ------------------------------------------------------------ freshness */

/**
 * A change made in the app, held over the list for a short while. Gmail's
 * thread list can lag a write by a few seconds, so a refresh that lands just
 * after an archive could bring the thread back: until `until`, the change is
 * laid over whatever the list says. `removedFrom` names the view a thread
 * left (an archive from the inbox); `patch` applies in every view.
 */
export interface PendingChange<R> {
  patch: Partial<R> | null;
  removedFrom?: string;
  until: number;
}

/** How long a change made in the app outranks Gmail's list. */
export const PENDING_MS = 30_000;

export function applyPending<R extends { id: string }>(
  rows: readonly R[],
  pending: Map<string, PendingChange<R>>,
  view: string,
  now: number,
): R[] {
  for (const [id, change] of pending) if (change.until <= now) pending.delete(id);
  return rows
    .filter((r) => pending.get(r.id)?.removedFrom !== view)
    .map((r) => {
      const patch = pending.get(r.id)?.patch;
      return patch ? { ...r, ...patch } : r;
    });
}
