import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';

/**
 * CONTRACT PLACEHOLDER — owned by WS4 (Guests). Replace the body, keep the
 * export: `RegistrationPanel` (props: EventPanelProps).
 *
 * WS5's /events/[id]?tab=registration mounts it. The real panel: access
 * mode, sessions editor, capacity, questions builder, plus-ones, waitlist,
 * closes-at. A server component; client islands inside.
 */
export function RegistrationPanel({ event }: EventPanelProps) {
  return (
    <Card data-panel="registration">
      <CardHeader>
        <div>
          <CardTitle>Registration</CardTitle>
          <CardDescription>
            Access, sessions and questions for {event.title} arrive in this build.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
