'use client';

import * as React from 'react';

/**
 * The library card's unseen-activity dot, and the marker that clears it.
 *
 * When each event was last opened is a per-viewer convenience, so it lives in
 * this browser (localStorage, read in try/catch: a private window or blocked
 * storage shows the dot until the event is opened, and never breaks the card).
 * The server supplies the other half: when a guest last registered or changed
 * (latestGuestActivity).
 */

const key = (eventId: string) => `tiptop-event-seen:${eventId}`;
const NOOP_UNSUBSCRIBE = () => {};
const subscribe = () => NOOP_UNSUBSCRIBE;

function readSeen(eventId: string): string | null {
  try {
    return window.localStorage.getItem(key(eventId));
  } catch {
    return null;
  }
}

export function ActivityDot({
  eventId,
  activityAt,
}: {
  eventId: string;
  /** The latest guest activity on the event, ISO; null for none. */
  activityAt: string | null;
}) {
  // undefined on the server and in the first client render, so the two match.
  const seen = React.useSyncExternalStore<string | null | undefined>(
    subscribe,
    () => readSeen(eventId),
    () => undefined,
  );
  if (!activityAt || seen === undefined) return null;
  const unseen = seen === null || Date.parse(activityAt) > Date.parse(seen);
  if (!unseen) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)]"
      title="Guest activity you have not opened yet"
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-[var(--gold)]" />
      New activity
    </span>
  );
}

/** Rendered on an event's page: this browser has now seen its activity. */
export function MarkSeen({ eventId }: { eventId: string }) {
  React.useEffect(() => {
    try {
      window.localStorage.setItem(key(eventId), new Date().toISOString());
    } catch {
      // Storage blocked: the dot shows until storage works again.
    }
  }, [eventId]);
  return null;
}
