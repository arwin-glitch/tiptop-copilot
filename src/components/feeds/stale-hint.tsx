import type { StaticFeedId } from '@/lib/feeds/registry';
import { mayBeOutOfDate } from '@/lib/feeds/status';

/**
 * " · may be out of date", after a card's own "checked" time, once the
 * routine that fills it looks stopped (lib/feeds/status.ts). Subtle on
 * purpose: the card still shows the last copy that arrived, and Diagnostics >
 * Feeds says more.
 */
export function StaleHint({
  feed,
  checkedAt,
  now,
}: {
  feed: StaticFeedId;
  checkedAt: string | null | undefined;
  now: Date;
}) {
  if (!mayBeOutOfDate(feed, checkedAt, now)) return null;
  return <span className="text-[var(--warn)]"> · may be out of date</span>;
}
