/**
 * Open the search palette from anywhere in the client: the desktop app's top
 * bar has a "Search Kraken" field that calls `openSearch()`. The palette
 * that owns Ctrl+K (the sidebar's, mounted at every width) listens for it.
 */
export const SEARCH_OPEN_EVENT = 'tiptop:search-open';

export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(SEARCH_OPEN_EVENT));
}

/**
 * The palette says when it opens and closes, so the bar's field can look
 * pressed while the search it opened is on screen. Detail: `{ open }`.
 */
export const SEARCH_STATE_EVENT = 'tiptop:search-state';

export interface SearchState {
  open: boolean;
}

export function announceSearchState(open: boolean): void {
  window.dispatchEvent(new CustomEvent<SearchState>(SEARCH_STATE_EVENT, { detail: { open } }));
}
