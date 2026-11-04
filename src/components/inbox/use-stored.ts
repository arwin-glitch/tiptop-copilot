'use client';

import * as React from 'react';
import {
  parseUndoSend,
  UNDO_SEND_DEFAULT,
  UNDO_SEND_KEY,
  undoSeconds,
} from '@/lib/email/undo-send';

const EVENT = 'kraken-inbox-stored';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * A small preference remembered per browser (the Inbox's density, whether
 * "More" is open), read without a hydration mismatch: the server and the
 * first paint use `fallback`, then the stored value. Storage that refuses
 * (a private window) leaves the fallback and the choice still applies until
 * reload.
 */
export function useStoredChoice<T extends string>(
  key: string,
  parse: (value: string | null) => T,
  fallback: T,
): [T, (next: T) => void] {
  const [unsaved, setUnsaved] = React.useState<T | null>(null);
  const read = React.useCallback(() => {
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return fallback;
    }
  }, [key, parse, fallback]);
  const stored = React.useSyncExternalStore(subscribe, read, () => fallback);
  const set = React.useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, next);
        setUnsaved(null);
      } catch {
        setUnsaved(next);
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [unsaved ?? stored, set];
}

/** Gmail's "Undo Send" period in seconds, as picked in the Inbox's ⋮ menu (per browser). */
export function useUndoSeconds(): number {
  const [choice] = useStoredChoice(UNDO_SEND_KEY, parseUndoSend, UNDO_SEND_DEFAULT);
  return undoSeconds(choice);
}
