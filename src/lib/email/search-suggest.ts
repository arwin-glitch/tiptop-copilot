/**
 * The Inbox search box's dropdown, as plain data: Gmail's quick chips, the
 * recent-search history kept per browser, and the query a picked person
 * becomes. Shared by the component and its tests.
 */

export const QUICK_CHIPS = [
  { id: 'attachment', label: 'Has attachment', operator: 'has:attachment' },
  { id: 'week', label: 'Last 7 days', operator: 'newer_than:7d' },
  { id: 'me', label: 'From me', operator: 'from:me' },
  { id: 'unread', label: 'Unread', operator: 'is:unread' },
] as const;
export type QuickChip = (typeof QUICK_CHIPS)[number];

/** The query with the operator added once (Gmail's chips never repeat one). */
export function addOperator(query: string, operator: string): string {
  const q = query.trim();
  const parts = q ? q.split(/\s+/) : [];
  if (parts.some((p) => p.toLowerCase() === operator.toLowerCase())) return q;
  return [...parts, operator].join(' ');
}

/** Whether the query already carries a chip's operator (the chip shows as on). */
export function hasOperator(query: string, operator: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .some((p) => p.toLowerCase() === operator.toLowerCase());
}

/** A picked person: everything from or to them, as Gmail's own people chip searches. */
export function personQuery(email: string): string {
  const clean = email.trim().toLowerCase();
  return `from:${clean} OR to:${clean}`;
}

export const HISTORY_KEY = 'kraken.inbox.searchHistory';
export const HISTORY_MAX = 8;
const ITEM_MAX = 300;

/** The stored history, newest first; anything unreadable is an empty history. */
export function parseHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
      if (typeof v !== 'string') continue;
      const q = v.trim().slice(0, ITEM_MAX);
      if (q && !out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
      if (out.length >= HISTORY_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** A search just run goes to the top; the same search (any case) once; at most eight. */
export function pushHistory(history: readonly string[], query: string): string[] {
  const q = query.trim().slice(0, ITEM_MAX);
  if (!q) return [...history];
  return [q, ...history.filter((h) => h.toLowerCase() !== q.toLowerCase())].slice(0, HISTORY_MAX);
}

export function removeHistory(history: readonly string[], query: string): string[] {
  return history.filter((h) => h !== query);
}
