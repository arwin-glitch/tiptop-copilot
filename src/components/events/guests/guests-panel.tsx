import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';

/**
 * CONTRACT PLACEHOLDER — owned by WS4 (Guests). Replace the body, keep the
 * export: `GuestsPanel` (props: EventPanelProps).
 *
 * WS5's /events/[id]?tab=guests mounts it. The real panel: status tabs with
 * counts, filters, search, the guest table, bulk bar, guest drawer, adding
 * from Copilot, CSV import/export. A server component; client islands inside.
 */
export function GuestsPanel({ event }: EventPanelProps) {
  return (
    <Card data-panel="guests">
      <CardHeader>
        <div>
          <CardTitle>Guests</CardTitle>
          <CardDescription>The guest list for {event.title} arrives in this build.</CardDescription>
        </div>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
