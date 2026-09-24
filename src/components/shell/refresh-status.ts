'use client';

import * as React from 'react';

/**
 * Whether a background `router.refresh()` is still loading.
 *
 * A page that writes its own URL with `history.pushState` (Deals) has to wait
 * for one: Next applies a pushed URL on top of the loading refresh, and until
 * that lands no update on the page renders, typing included.
 */
const loading = new Set<symbol>();
const listeners = new Set<() => void>();

function mark(token: symbol, on: boolean) {
  if (loading.has(token) === on) return;
  if (on) loading.add(token);
  else loading.delete(token);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRefreshLoading(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => loading.size > 0,
    () => false,
  );
}

/**
 * Reports a transition that runs `router.refresh()`. Call the returned
 * function right before starting it; `isPending` going false ends it.
 */
export function useReportRefresh(isPending: boolean): () => void {
  const [token] = React.useState(() => Symbol('refresh'));
  // Runs when isPending changes, not when the refresh starts, so the moment
  // before isPending turns true cannot end it early.
  React.useEffect(() => {
    if (!isPending) mark(token, false);
  }, [isPending, token]);
  React.useEffect(() => () => mark(token, false), [token]);
  return React.useCallback(() => mark(token, true), [token]);
}
