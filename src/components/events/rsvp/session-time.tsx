'use client';

import { useSyncExternalStore } from 'react';
import { differsFromViewer, formatRange } from '@/lib/events/format';

/**
 * A session's time in the venue's zone, plus "your time" when the viewer's
 * zone shows a different clock. The viewer's zone is read only on the client
 * (the server snapshot is null), so the server render and hydration match.
 */

const noSubscribe = () => () => undefined;

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function useViewerZone(): string | null {
  return useSyncExternalStore(noSubscribe, browserZone, () => null);
}

export function SessionTime({
  startsAt,
  endsAt,
  timeZone,
  className,
}: {
  startsAt: string | null;
  endsAt: string | null;
  timeZone: string;
  className?: string;
}) {
  const viewerZone = useViewerZone();
  if (!startsAt) return null;
  const venue = formatRange(startsAt, endsAt, timeZone);
  const showYours = viewerZone && differsFromViewer(startsAt, timeZone, viewerZone);
  return (
    <span className={className}>
      <span>{venue}</span>
      {showYours ? (
        <span className="evu-muted evu-small" style={{ display: 'block' }}>
          Your time: {formatRange(startsAt, endsAt, viewerZone)}
        </span>
      ) : null}
    </span>
  );
}
