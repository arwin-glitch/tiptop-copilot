import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';

/**
 * CONTRACT PLACEHOLDER — owned by WS4 (Guests). Replace the body, keep the
 * export: `CheckinPanel` (props: EventPanelProps).
 *
 * WS5's /events/[id]?tab=checkin mounts it. The real panel: live counters
 * per session, the door list with one-tap check-in and undo, walk-ins and
 * door mode. A server component; client islands inside.
 */
export function CheckinPanel({ event }: EventPanelProps) {
  return (
    <Card data-panel="checkin">
      <CardHeader>
        <div>
          <CardTitle>Check-in</CardTitle>
          <CardDescription>The door list for {event.title} arrives in this build.</CardDescription>
        </div>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
