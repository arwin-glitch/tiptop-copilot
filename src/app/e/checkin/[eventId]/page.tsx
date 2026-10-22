import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { DoorList } from '@/components/events/checkin/door-list';
import { EventShell } from '@/components/events/ticket/event-shell';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { doorList, eventForStaff, resolveCheckinActor } from '@/lib/services/event-checkin';
import { publishedDoc } from '@/lib/services/event-public';

/**
 * /e/checkin/<eventId> — the door list for staff (D-075): a claimed staff
 * link (the tiptop_ev_grant cookie, role 'checkin', re-checked on every
 * request, ending 12 h after the event) or an owner's own session. Anyone
 * else gets the same plain 404 as an unknown event. Names, companies and
 * check-in times only.
 */

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ eventId: string }> };

export const metadata: Metadata = {
  title: { absolute: 'Door list' },
  applicationName: null,
  appleWebApp: null,
  robots: { index: false, follow: false, nocache: true },
};

export default async function DoorListPage({ params }: Props) {
  const { eventId } = await params;
  const store = getStore();
  const event = await eventForStaff(store, eventId);
  if (!event) notFound();
  const jar = await cookies();
  const actor = await resolveCheckinActor(store, event, jar.get(GRANT_COOKIE)?.value);
  if (!actor) notFound();
  const list = await doorList(store, event.organization_id, event.id);
  if (!list.ok) notFound();
  return (
    <EventShell
      doc={event.published_doc ? publishedDoc(event) : null}
      label={`Door list for ${event.title}`}
    >
      <DoorList
        kind={actor.kind === 'owner' ? 'owner' : 'staff'}
        eventId={event.id}
        initial={list.value}
      />
    </EventShell>
  );
}
