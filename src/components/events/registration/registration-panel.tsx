import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EventPanelProps } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { getRegistration } from '@/lib/services/event-registration';
import { RegistrationEditor } from './registration-editor';

/**
 * RegistrationPanel (D-075, WS4) — the event's Registration tab, mounted by
 * WS5's /events/[id]?tab=registration: access mode, capacity, sessions,
 * questions, plus-ones, waitlist and closes-at. A server component that
 * loads its own data and passes plain settings to the client editor.
 */
export async function RegistrationPanel({ event }: EventPanelProps) {
  const view = await getRegistration(getStore(), event.organization_id, event.id);
  return (
    <Card data-panel="registration">
      <CardHeader>
        <div>
          <CardTitle>Registration</CardTitle>
          <CardDescription>
            Who can RSVP to {event.title}, for which sessions, and what you ask them.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {view.ok ? (
          <RegistrationEditor
            eventId={event.id}
            timeZone={view.value.timeZone}
            access={view.value.access}
            capacity={view.value.capacity}
            registration={view.value.registration}
            questions={view.value.questions}
            sessions={view.value.sessions}
            going={view.value.going}
          />
        ) : (
          <p className="text-sm text-[var(--fg-muted)]" role="alert">
            {view.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
