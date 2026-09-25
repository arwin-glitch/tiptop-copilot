'use client';

import * as React from 'react';

/**
 * Keeps keyboard focus in place when a row's own button takes the row off the
 * list (Reopen, Unsnooze, Mark complete). Call the returned `leaving(id,
 * index)` when the action succeeds; once a refresh has removed that row, and
 * unless focus has moved on, focus lands on the row that took its place, else
 * on the tab the list belongs to. Rows carry `data-index`.
 */
export function useFocusAfterRemoval(
  items: readonly { id: string }[],
  root: React.RefObject<HTMLElement | null>,
): (id: string, index: number) => void {
  const gone = React.useRef<{ id: string; index: number } | null>(null);

  React.useEffect(() => {
    const row = gone.current;
    if (!row || items.some((item) => item.id === row.id)) return;
    gone.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const rows = root.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [];
    const next = rows[Math.min(row.index, rows.length - 1)];
    if (next) {
      next.focus();
      return;
    }
    const tab = root.current?.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby');
    if (tab) document.getElementById(tab)?.focus();
  }, [items, root]);

  return React.useCallback((id: string, index: number) => {
    gone.current = { id, index };
  }, []);
}
