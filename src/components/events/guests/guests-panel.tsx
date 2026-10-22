import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { listGuests } from '@/lib/services/event-guests';
import { GuestsManager } from './guests-manager';

/**
 * GuestsPanel (D-075, WS4) — the event's Guests tab, mounted by WS5's
 * /events/[id]?tab=guests. A server component: it loads the roster with the
 * store (owners only, signed in) and hands the client table plain rows,
 * never the event row itself (its documents stay on the server).
 */
export async function GuestsPanel({ event, sessions }: EventPanelProps) {
  const roster = await listGuests(getStore(), event.organization_id, event.id);
  return (
    <Card data-panel="guests">
      <CardHeader>
        <div>
          <CardTitle>Guests</CardTitle>
          <CardDescription>
            Everyone on the list for {event.title}. Nothing here emails anyone: status changes wait
            in “Needs notifying” on the Messages tab.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {roster.ok ? (
          <GuestsManager
            eventId={event.id}
            slug={event.slug}
            timeZone={event.time_zone}
            guests={roster.value.guests}
            sessions={sessions.map((s) => ({ id: s.id, name: s.name, capacity: s.capacity }))}
            questions={roster.value.questions}
            counts={roster.value.counts}
          />
        ) : (
          <p className="text-sm text-[var(--fg-muted)]" role="alert">
            {roster.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
