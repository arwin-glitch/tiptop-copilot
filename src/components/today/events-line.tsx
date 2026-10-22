import Link from 'next/link';
import { Ticket } from 'lucide-react';
import { getStore } from '@/lib/runtime';
import { todayEventLines } from '@/lib/services/event-overview';

/**
 * Today's quiet line per event that wants something (D-075):
 * "Harborview Annual Meeting: 3 pending · 2 new registrations · reminder
 * ready · 2 outside edits to publish". Each part links to where it is done.
 * A line, not a card, like the Affinity exit line: it takes no room from Top
 * priorities or the glance cards, and with nothing to do it is not there.
 * Loads its own data and never throws.
 */
export async function EventsLine({ organizationId, now }: { organizationId: string; now: Date }) {
  const lines = await todayEventLines(getStore(), organizationId, now).catch(() => []);
  if (!lines.length) return null;
  return (
    <ul aria-label="Events that need you" className="mb-5 space-y-1">
      {lines.map((line) => (
        <li
          key={line.eventId}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--fg-muted)]"
        >
          <Ticket className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <Link href={line.href} className="font-medium text-[var(--fg)] hover:underline">
            {line.title}
          </Link>
          <span aria-hidden="true">:</span>
          {line.parts.map((part, i) => (
            <span key={part.text} className="inline-flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden="true">·</span> : null}
              <Link href={part.href} className="link-inline">
                {part.text}
              </Link>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
