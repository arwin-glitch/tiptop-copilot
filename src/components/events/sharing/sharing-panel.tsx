import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';

/**
 * CONTRACT PLACEHOLDER — owned by WS3 (Studio and collaboration). Replace
 * the body, keep the export: `SharingPanel` (props: EventPanelProps).
 *
 * WS5's /events/[id]?tab=sharing mounts it. The real panel: outside-editor
 * links (create once-shown link, scope, brand lock, expiry, regenerate,
 * revoke, pause editing, revoke all), staff check-in links and the share kit
 * (link, QR, OG preview). A server component; client islands inside.
 */
export function SharingPanel({ event }: EventPanelProps) {
  return (
    <Card data-panel="sharing">
      <CardHeader>
        <div>
          <CardTitle>Sharing</CardTitle>
          <CardDescription>
            Outside editors, staff check-in links and the share kit for {event.title} arrive in this
            build.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
