'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, NotebookPen, Radio } from 'lucide-react';
import { NOTES_API } from '@/lib/notes/api';
import type { RangeEvent } from '@/lib/calendar/range-types';
import type {
  CreateMeetingRequest,
  CreateMeetingResponse,
  ListMeetingsResponse,
  MeetingListItem,
} from '@/lib/types/notes';
import { formatMonthDay } from '@/lib/util/time';
import { Button } from '@/components/ui/button';
import { notesCall, notesEnabled } from './api-client';
import { platformOf } from './helpers';

type Loaded = {
  enabled: boolean;
  /** The Copilot meeting made for this event, if any. */
  mine: MeetingListItem | null;
  past: MeetingListItem[];
};

const PAST_GUESTS = 3;
const PAST_SHOWN = 3;

/** Where a list row opens: a Copilot meeting's page, or the Granola note by its title. */
export function noteHref(item: MeetingListItem): string {
  return item.meetingId
    ? `/meetings/${encodeURIComponent(item.meetingId)}`
    : `/meetings?tab=notes&q=${encodeURIComponent(item.title)}`;
}

/**
 * Copilot Notes on a calendar event's card (D-076), one slot in event-panel:
 * a gold "Take notes" (which makes the meeting with its guests attached and
 * opens the consent step), "Notes ready" once they are written, and the
 * latest notes with these people. Renders nothing while Notes is off.
 */
export function MeetingNotesSlot({
  event,
  timeZone,
  ownEmails,
}: {
  event: RangeEvent;
  timeZone: string;
  ownEmails: readonly string[];
}) {
  const router = useRouter();
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [opening, setOpening] = React.useState(false);
  const own = React.useMemo(() => new Set(ownEmails.map((e) => e.toLowerCase())), [ownEmails]);
  const guests = React.useMemo(
    () =>
      event.attendees
        .filter((a) => !a.resource && !a.self && !own.has(a.email.toLowerCase()))
        .map((a) => ({ email: a.email.toLowerCase(), name: a.name ?? null })),
    [event.attendees, own],
  );
  const guestKey = guests.map((g) => g.email).join(',');

  React.useEffect(() => {
    let live = true;
    void (async () => {
      if (!(await notesEnabled())) {
        if (live) setLoaded({ enabled: false, mine: null, past: [] });
        return;
      }
      const emails = guestKey ? guestKey.split(',').slice(0, PAST_GUESTS) : [];
      const [mine, ...byGuest] = await Promise.all([
        notesCall<Omit<ListMeetingsResponse, 'ok'>>(
          'GET',
          `${NOTES_API.meetings}?source=copilot&eventId=${encodeURIComponent(event.id)}`,
        ),
        ...emails.map((email) =>
          notesCall<Omit<ListMeetingsResponse, 'ok'>>(
            'GET',
            `${NOTES_API.meetings}?person=${encodeURIComponent(email)}`,
          ),
        ),
      ]);
      if (!live) return;
      const now = Date.now();
      const seen = new Set<string>();
      const ownMeeting = mine?.ok ? (mine.meetings[0] ?? null) : null;
      const past = byGuest
        .flatMap((r) => (r.ok ? r.meetings : []))
        .filter((m) => {
          if (seen.has(m.qualifiedId) || m.qualifiedId === ownMeeting?.qualifiedId) return false;
          seen.add(m.qualifiedId);
          return Date.parse(m.occurredAt) < now && m.status !== 'scheduled';
        })
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, PAST_SHOWN);
      setLoaded({ enabled: true, mine: ownMeeting, past });
    })();
    return () => {
      live = false;
    };
  }, [event.id, guestKey]);

  // Real meetings only: a block with nobody else in it (the gym, a hold) has nothing to note.
  if (!loaded?.enabled || event.allDay || (!event.verdict.meeting && guests.length === 0)) {
    return null;
  }

  const takeNotes = async () => {
    setOpening(true);
    const join = event.meetUrl ?? event.joinUrl;
    const body: CreateMeetingRequest = {
      source: 'calendar',
      providerEventId: event.id,
      recurringEventId: event.recurringEventId,
      calendarId: event.calendarId,
      title: event.title || 'Meeting',
      kind: event.inPerson ? 'in_person' : 'video',
      platform: platformOf(join),
      scheduledStart: event.startsAt,
      scheduledEnd: event.endsAt,
      attendees: guests,
    };
    const res = await notesCall<Omit<CreateMeetingResponse, 'ok'>>(
      'POST',
      NOTES_API.meetings,
      body,
    );
    setOpening(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    const startNow = res.meeting.status === 'scheduled';
    router.push(`/meetings/${encodeURIComponent(res.meeting.id)}${startNow ? '?start=1' : ''}`);
  };

  const mine = loaded.mine;
  const ready = mine?.status === 'ready' || mine?.status === 'processing';
  const live = mine?.status === 'recording' || mine?.status === 'paused';

  return (
    <div
      className="flex items-start gap-3 border-t border-[var(--border)] pt-3 text-sm"
      data-meeting-notes-slot=""
    >
      <NotebookPen className="mt-0.5 size-4 shrink-0 text-[var(--gold)]" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {ready && mine ? (
            <>
              <span className="inline-flex items-center gap-1 font-medium text-[var(--ok)]">
                <CheckCircle2 className="size-4" aria-hidden /> Notes ready
              </span>
              <Button asChild size="sm" variant="secondary">
                <Link href={noteHref(mine)}>Open notes</Link>
              </Button>
            </>
          ) : live && mine ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={noteHref(mine)}>
                <Radio aria-hidden className="text-[var(--danger)]" /> Recording: open notes
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void takeNotes()}
              loading={opening}
              className="bg-[var(--label-gold)] text-[var(--bg)] hover:opacity-90"
            >
              <NotebookPen aria-hidden /> Take notes
            </Button>
          )}
        </div>
        {loaded.past.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-[var(--fg-muted)]">
              Past notes with these people
            </p>
            <ul className="mt-1 space-y-0.5">
              {loaded.past.map((m) => (
                <li key={m.qualifiedId} className="flex items-baseline gap-2">
                  <Link href={noteHref(m)} className="link-inline min-w-0 truncate">
                    {m.title}
                  </Link>
                  <span className="shrink-0 text-xs text-[var(--fg-subtle)]">
                    {formatMonthDay(m.occurredAt, timeZone)} ·{' '}
                    {m.source === 'copilot' ? 'Copilot' : 'Granola'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
