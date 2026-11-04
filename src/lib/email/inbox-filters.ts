import { buildGmailQuery, EMPTY_SEARCH, type AdvancedSearch } from './inbox-folders';

/**
 * Gmail's "Create filter", as plain data shared by the dialog and the
 * server: the criteria (Gmail's own six), the actions Kraken offers, and
 * the Gmail filter body they become. Forwarding and "Delete it" are not
 * actions here at all: the body never carries `forward`, and no action puts
 * TRASH on mail. The server checks the body again (lib/google/gmail-filters).
 */

export interface FilterCriteria {
  from: string;
  to: string;
  subject: string;
  /** "Has the words": Gmail's `query`. */
  hasWords: string;
  /** "Doesn't have": Gmail's `negatedQuery`. */
  doesntHave: string;
  hasAttachment: boolean;
}

/** Gmail's "Categorize as" choices and the label each puts on. */
export const FILTER_CATEGORIES = [
  { id: 'CATEGORY_PERSONAL', label: 'Primary' },
  { id: 'CATEGORY_SOCIAL', label: 'Social' },
  { id: 'CATEGORY_UPDATES', label: 'Updates' },
  { id: 'CATEGORY_FORUMS', label: 'Forums' },
  { id: 'CATEGORY_PROMOTIONS', label: 'Promotions' },
] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number]['id'];

export interface FilterActions {
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  /** "Apply the label": one of the person's own label ids, or empty. */
  label: string;
  neverSpam: boolean;
  important: '' | 'always' | 'never';
  category: FilterCategory | '';
}

export const NO_ACTIONS: FilterActions = {
  skipInbox: false,
  markRead: false,
  star: false,
  label: '',
  neverSpam: false,
  important: '',
  category: '',
};

/** The body Gmail's filters.create takes. Never a `forward`. */
export interface GmailFilterBody {
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
  };
  action: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

/** A filter as Gmail lists it (only the fields Kraken reads). */
export interface GmailFilter {
  id: string;
  criteria?: GmailFilterBody['criteria'] & { size?: number; sizeComparison?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

const USER_LABEL = /^Label_[0-9A-Za-z]{1,40}$/;
const CATEGORY_IDS = new Set<string>(FILTER_CATEGORIES.map((c) => c.id));

/** What a filter may put on mail: star, important, a category, or one of the person's labels. */
export function filterMayAdd(label: string): boolean {
  return (
    label === 'STARRED' ||
    label === 'IMPORTANT' ||
    CATEGORY_IDS.has(label) ||
    USER_LABEL.test(label)
  );
}

/** What a filter may take off: inbox (skip it), unread (mark read), spam (never spam), important. */
export function filterMayRemove(label: string): boolean {
  return label === 'INBOX' || label === 'UNREAD' || label === 'SPAM' || label === 'IMPORTANT';
}

const clean = (s: string, max = 500) =>
  s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The search's own fields, as a filter's criteria. "Date within" has no filter equivalent. */
export function criteriaFromSearch(form: AdvancedSearch): FilterCriteria {
  return {
    from: clean(form.from),
    to: clean(form.to),
    subject: clean(form.subject),
    hasWords: clean(form.hasWords),
    doesntHave: clean(form.doesntHave),
    hasAttachment: form.hasAttachment,
  };
}

export function hasCriteria(c: FilterCriteria): boolean {
  return Boolean(c.from || c.to || c.subject || c.hasWords || c.doesntHave || c.hasAttachment);
}

export function hasActions(a: FilterActions): boolean {
  return Boolean(
    a.skipInbox || a.markRead || a.star || a.label || a.neverSpam || a.important || a.category,
  );
}

/** The Gmail search a filter's criteria match: what "Also apply to matching conversations" reads. */
export function criteriaQuery(c: FilterCriteria): string {
  return buildGmailQuery({
    ...EMPTY_SEARCH,
    from: c.from,
    to: c.to,
    subject: c.subject,
    hasWords: c.hasWords,
    doesntHave: c.doesntHave,
    hasAttachment: c.hasAttachment,
  });
}

/** The label changes the actions make, as Gmail's filter action. */
export function actionLabels(a: FilterActions): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  if (a.skipInbox) remove.push('INBOX');
  if (a.markRead) remove.push('UNREAD');
  if (a.star) add.push('STARRED');
  if (a.label && USER_LABEL.test(a.label)) add.push(a.label);
  if (a.neverSpam) remove.push('SPAM');
  if (a.important === 'always') add.push('IMPORTANT');
  if (a.important === 'never') remove.push('IMPORTANT');
  if (a.category && CATEGORY_IDS.has(a.category)) add.push(a.category);
  return { add, remove };
}

export type FilterBodyResult = { ok: true; body: GmailFilterBody } | { ok: false; message: string };

/** The criteria and actions as Gmail's filter body, or why not. */
export function buildFilterBody(c: FilterCriteria, a: FilterActions): FilterBodyResult {
  if (!hasCriteria(c)) return { ok: false, message: 'Fill in at least one search field.' };
  if (!hasActions(a)) return { ok: false, message: 'Pick at least one action.' };
  const { add, remove } = actionLabels(a);
  if (add.some((l) => !filterMayAdd(l)) || remove.some((l) => !filterMayRemove(l))) {
    return { ok: false, message: 'That action is not offered here.' };
  }
  const criteria: GmailFilterBody['criteria'] = {};
  if (clean(c.from)) criteria.from = clean(c.from);
  if (clean(c.to)) criteria.to = clean(c.to);
  if (clean(c.subject)) criteria.subject = clean(c.subject);
  if (clean(c.hasWords)) criteria.query = clean(c.hasWords);
  if (clean(c.doesntHave)) criteria.negatedQuery = clean(c.doesntHave);
  if (c.hasAttachment) criteria.hasAttachment = true;
  return {
    ok: true,
    body: {
      criteria,
      action: {
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      },
    },
  };
}

/** A body the server will send Gmail: only offered labels, never a forward, never TRASH. */
export function isSafeFilterBody(body: unknown): body is GmailFilterBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const action = b.action as Record<string, unknown> | undefined;
  if (!action || typeof action !== 'object') return false;
  if (Object.keys(action).some((k) => k !== 'addLabelIds' && k !== 'removeLabelIds')) return false;
  const add = (action.addLabelIds ?? []) as unknown[];
  const remove = (action.removeLabelIds ?? []) as unknown[];
  if (!Array.isArray(add) || !Array.isArray(remove)) return false;
  if (add.length + remove.length === 0) return false;
  return (
    add.every((l) => typeof l === 'string' && filterMayAdd(l)) &&
    remove.every((l) => typeof l === 'string' && filterMayRemove(l))
  );
}

/**
 * The changes "Also apply filter to matching conversations" may make with
 * the Inbox's own label path: inbox, read state, star, important and the
 * person's label. Categories and "Never send it to Spam" apply to new mail
 * only (Gmail's own apply-to-existing behaves the same for Spam).
 */
export function existingChange(a: FilterActions): { add: string[]; remove: string[] } {
  const { add, remove } = actionLabels(a);
  const writable = (l: string) =>
    l === 'INBOX' || l === 'UNREAD' || l === 'STARRED' || l === 'IMPORTANT' || USER_LABEL.test(l);
  return { add: add.filter(writable), remove: remove.filter(writable) };
}

/** At most this many matching conversations get the filter's actions at once. */
export const APPLY_EXISTING_MAX = 100;

const SYSTEM_NAMES: Record<string, string> = {
  STARRED: 'Star it',
  IMPORTANT: 'Always mark it as important',
};

/** A filter's criteria in Gmail's words: `from:(a) subject:(b) has:attachment`. */
export function describeCriteria(c: GmailFilter['criteria']): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.from) parts.push(`from:(${c.from})`);
  if (c.to) parts.push(`to:(${c.to})`);
  if (c.subject) parts.push(`subject:(${c.subject})`);
  if (c.query) parts.push(c.query);
  if (c.negatedQuery) parts.push(`-{${c.negatedQuery}}`);
  if (c.hasAttachment) parts.push('has:attachment');
  if (c.size) parts.push(`size ${c.sizeComparison === 'smaller' ? '<' : '>'} ${c.size}`);
  return parts.join(' ');
}

/** A filter's actions in Gmail's words, the person's label names filled in. */
export function describeActions(
  a: GmailFilter['action'],
  labelNames: ReadonlyMap<string, string>,
): string[] {
  if (!a) return [];
  const out: string[] = [];
  for (const id of a.removeLabelIds ?? []) {
    if (id === 'INBOX') out.push('Skip Inbox');
    else if (id === 'UNREAD') out.push('Mark as read');
    else if (id === 'SPAM') out.push('Never send it to Spam');
    else if (id === 'IMPORTANT') out.push('Never mark it as important');
    else out.push(`Remove ${labelNames.get(id) ?? id}`);
  }
  for (const id of a.addLabelIds ?? []) {
    const category = FILTER_CATEGORIES.find((c) => c.id === id);
    if (SYSTEM_NAMES[id]) out.push(SYSTEM_NAMES[id]);
    else if (category) out.push(`Categorize as ${category.label}`);
    else if (id === 'TRASH') out.push('Delete it (set in Gmail)');
    else out.push(`Apply label "${labelNames.get(id) ?? id}"`);
  }
  // Shown so the list is honest about what Gmail does; Kraken never sets one.
  if (a.forward) out.push('Forwards mail (set in Gmail)');
  return out;
}
