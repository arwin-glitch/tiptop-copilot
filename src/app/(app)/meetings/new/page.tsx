import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { calendarSource } from '@/lib/calendar/range-reader';
import type { GCalEvent } from '@/lib/calendar/google-types';
import { notesAccess } from '@/lib/notes/flag';
import { getStore } from '@/lib/runtime';
import { listTemplates } from '@/lib/services/notes';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { tabHref } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/feedback';
import { platformOf } from '@/components/notes/helpers';
import { NewNoteForm, type NewNotePrefill } from '@/components/notes/new-note-form';

export const metadata: Metadata = { title: 'New note' };
export const dynamic = 'force-dynamic';

const EVENT_ID = /^[\w-]{3,200}$/;
const CALENDAR_ID = /^[\w.@#-]{1,200}$/;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function prefillFromEvent(event: GCalEvent, calendarId: string, ownEmail: string): NewNotePrefill {
  const join = event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? null;
  const own = ownEmail.toLowerCase();
  return {
    source: 'calendar',
    providerEventId: event.id,
    recurringEventId: event.recurringEventId ?? null,
    calendarId,
    title: event.summary?.trim() || 'Meeting',
    kind: join ? 'video' : event.location ? 'in_person' : 'video',
    platform: platformOf(join),
    scheduledStart: event.start?.dateTime ?? null,
    scheduledEnd: event.end?.dateTime ?? null,
    attendees: (event.attendees ?? [])
      .filter((a) => a.email && !a.resource && !a.self && a.email.toLowerCase() !== own)
      .map((a) => ({ email: (a.email as string).toLowerCase(), name: a.displayName ?? null })),
  };
}

/**
 * Notes for a call that is not on the calendar ("+ New note"), or for one
 * that is ("Start notes" from a meeting alert: /meetings/new?event=<id>).
 */
export default async function NewNotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const auth = await requireAuth();
  const store = getStore();
  const access = await notesAccess(store, auth);
  if (!access.enabled) notFound();

  const eventId = single(query.event);
  const calendarId = single(query.calendar) ?? 'primary';
  let prefill: NewNotePrefill = {
    source: 'adhoc',
    providerEventId: null,
    recurringEventId: null,
    calendarId: null,
    title: '',
    kind: 'video',
    platform: null,
    scheduledStart: null,
    scheduledEnd: null,
    attendees: [],
  };
  let missedEvent = false;
  if (eventId && EVENT_ID.test(eventId) && CALENDAR_ID.test(calendarId)) {
    const ownEmail = auth.profile.email ?? '';
    const source = await calendarSource(store, auth.organizationId, ownEmail).catch(() => null);
    const event =
      source && source.ok
        ? await source.source.provider.getEvent(calendarId, eventId).catch(() => null)
        : null;
    if (event?.ok) prefill = prefillFromEvent(event.value, calendarId, ownEmail);
    else missedEvent = true;
  }
  const templates = await listTemplates({ store, auth });

  return (
    <PageShell>
      <Link
        href={tabHref(MEETINGS_TABS.path, 'notes', MEETINGS_TABS.defaultKey)}
        className="text-mini mb-3 inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All notes
      </Link>
      <PageHeader
        eyebrow="Kraken Notes"
        title={prefill.source === 'calendar' ? 'Start notes' : 'New note'}
        subtitle="Open the notes, then tell everyone it is being transcribed before you start."
      />
      {missedEvent ? (
        <Notice className="mb-4">
          That calendar event could not be read, so nothing is filled in. Add the details here.
        </Notice>
      ) : null}
      <NewNoteForm prefill={prefill} templates={templates.ok ? templates.value : []} />
    </PageShell>
  );
}
