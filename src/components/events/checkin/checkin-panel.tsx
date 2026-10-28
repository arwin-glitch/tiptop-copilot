import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { doorList } from '@/lib/services/event-checkin';
import { DoorList } from './door-list';

/**
 * CheckinPanel (D-075, WS4) — the event's Check-in tab, mounted by WS5's
 * /events/[id]?tab=checkin: live counters per session, the door list with
 * one-tap check-in and undo, walk-ins and Door mode. Guests' QR codes open
 * /e/<slug>/c/<token>; any phone camera checks them in when this browser is
 * signed in (or holds a staff link, made on the Sharing tab).
 */
export async function CheckinPanel({ event }: EventPanelProps) {
  const list = await doorList(getStore(), event.organization_id, event.id);
  return (
    <Card data-panel="checkin">
      <CardHeader>
        <div>
          <CardTitle>Check-in</CardTitle>
          <CardDescription>
            Scan a guest’s QR with your phone camera, or tap them in here. Staff links (Sharing tab)
            open the same list on any phone without a Kraken account.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {list.ok ? (
          <DoorList kind="owner" eventId={event.id} initial={list.value} embedded />
        ) : (
          <p className="text-sm text-[var(--fg-muted)]" role="alert">
            {list.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
