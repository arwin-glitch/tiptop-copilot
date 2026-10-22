import Link from 'next/link';
import { Pencil, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActivityDot } from '@/components/events/library/activity-dot';
import { CopyLinkButton, EventCardActions } from '@/components/events/library/card-actions';
import { EventThumb } from '@/components/events/library/event-thumb';
import { eventPaths, type EventSummary } from '@/lib/events/contracts';
import { countsLine, formatWhen, statusChip } from '@/lib/events/tab-view';

/**
 * One event in the library: its thumbnail, title, when (in the venue's time
 * zone), a status chip, the headcount and the quick actions. A server
 * component; the actions are a client island.
 */
export function EventCard({
  event,
  activityAt,
  now,
}: {
  event: EventSummary;
  activityAt: string | null;
  now: Date;
}) {
  const chip = statusChip(
    {
      status: event.status,
      visibility: event.visibility,
      access: event.access,
      isTemplate: event.isTemplate,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    },
    now,
  );
  const live = event.status === 'published';
  return (
    <li
      className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
      aria-labelledby={`event-${event.id}-title`}
    >
      <Link
        href={eventPaths.detail(event.id)}
        className="block p-3 pb-0"
        tabIndex={-1}
        aria-hidden="true"
      >
        <EventThumb title={event.title} ogImageUrl={event.ogImageUrl} swatch={event.swatch} />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={chip.tone}>{chip.label}</Badge>
          {live && event.hasUnpublishedChanges ? (
            <Badge tone="warn" title="Edits in Studio that are not on the live page yet">
              Unpublished changes
            </Badge>
          ) : null}
          <ActivityDot eventId={event.id} activityAt={activityAt} />
        </div>
        <h2
          id={`event-${event.id}-title`}
          className="font-serif text-lg leading-snug font-semibold"
        >
          <Link href={eventPaths.detail(event.id)} className="underline-offset-2 hover:underline">
            {event.title}
          </Link>
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">
          {formatWhen(event.startsAt, event.endsAt, event.timeZone)}
        </p>
        <p className="tabular text-sm">{countsLine(event.counts)}</p>
        <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-2">
          <Button asChild size="sm" variant="ghost">
            <Link href={eventPaths.studio(event.id)}>
              <Pencil aria-hidden="true" />
              Edit page
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={eventPaths.detail(event.id, 'guests')}>
              <Users aria-hidden="true" />
              Guests
            </Link>
          </Button>
          <CopyLinkButton slug={event.slug} live={live} />
          <EventCardActions
            eventId={event.id}
            title={event.title}
            status={event.status}
            isTemplate={event.isTemplate}
          />
        </div>
      </div>
    </li>
  );
}
