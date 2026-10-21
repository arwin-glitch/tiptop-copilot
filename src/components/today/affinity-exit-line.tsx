import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import {
  daysLeftLabel,
  noticeDateLabel,
  type AffinityExitCountdown,
} from '@/lib/crm/affinity-exit';
import { AFFINITY_EXIT_HREF } from '@/lib/records-tabs';

/**
 * Today's one quiet line about leaving Affinity: shown only in the last two
 * weeks before the notice date someone set on the exit checklist, and never
 * once it is ticked Cancelled (`affinityExitTodayLine` decides). A line, not
 * a card: it sits outside Top priorities and the glance cards and takes no
 * room from them.
 */
export function AffinityExitLine({ countdown }: { countdown: AffinityExitCountdown }) {
  const when = daysLeftLabel(countdown.daysLeft);
  return (
    <p className="mb-5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--fg-muted)]">
      <CalendarClock className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      <span>
        Affinity notice is due {when} ({noticeDateLabel(countdown.dateKey)}).
      </span>
      <Link href={AFFINITY_EXIT_HREF} className="link-inline">
        Affinity exit checklist →
      </Link>
    </p>
  );
}
