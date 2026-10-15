/**
 * Subtabs on a server page, held in the URL as `?tab=<key>`.
 *
 * Pure helpers with no React and no server-only imports, so the page (a server
 * component), the tab bar (a client component) and the unit tests can all use
 * them. The same `tab` name is what `src/lib/ai/citations.ts` already puts on
 * deal links.
 */

/** One subtab: its URL key, the short label on the bar, and what it holds. */
export interface PageTabDef<K extends string = string> {
  key: K;
  label: string;
  /** One plain line on what the tab shows, for help text. */
  blurb: string;
}

/** A search param's first value; Next hands a repeated param over as an array. */
export function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The tab a raw `?tab` value names; anything unknown or missing gets the fallback. */
export function resolveTab<K extends string>(
  raw: string | string[] | undefined,
  keys: readonly K[],
  fallback: K,
): K {
  const value = single(raw);
  return value !== undefined && (keys as readonly string[]).includes(value)
    ? (value as K)
    : fallback;
}

/**
 * The link to a tab. The default tab is the bare path, so the page's plain
 * URL stays the one everything else links to. Every other search param is
 * dropped on purpose: filters and searches belong to the tab they were made
 * on, and leaving them out keeps the link exact on the server.
 */
export function tabHref(path: string, key: string, defaultKey: string): string {
  return key === defaultKey ? path : `${path}?tab=${encodeURIComponent(key)}`;
}

/** The search param that says how far a long list has been expanded. */
export const SHOW_PARAM = 'show';

/**
 * How many rows of a long list to render, from `?show=`: one page of `step`
 * by default, one more page with each "Show more". Anything that is not a
 * whole number above `step` reads as the first page, and `max` caps a
 * hand-typed one.
 */
export function shownCount(raw: string | string[] | undefined, step: number, max: number): number {
  const value = Number(single(raw));
  if (!Number.isInteger(value) || value <= step) return step;
  return Math.min(value, Math.max(max, step));
}

/**
 * The link that renders one more page of a list: the same tab and params,
 * with `?show=` grown by a page. Empty params are left out.
 */
export function showMoreHref(
  path: string,
  params: Readonly<Record<string, string | undefined>>,
  shown: number,
  step: number,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  search.set(SHOW_PARAM, String(shown + step));
  return `${path}?${search.toString()}`;
}
