import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Bell, BellOff, MapPin, Video } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { isDateKey, viewRange } from '@/lib/calendar/grid';
import { physicalLocation } from '@/lib/calendar/meetings';
import { calendarSource, readCalendarRange } from '@/lib/calendar/range-reader';
import { CALENDAR_VIEWS, type CalendarViewKind } from '@/lib/calendar/range-types';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { getStore } from '@/lib/runtime';
import { readCalendarDay, type CalendarEntry } from '@/lib/services/calendar-view';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { mailboxCanSend } from '@/lib/services/docsend-follow-up';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { CalendarViews } from '@/components/calendar/calendar-views';
import { PreviewSwitch } from '@/components/calendar/preview-switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ThreadLinks } from '@/components/email/thread-links';
import { Notice, SkeletonText } from '@/components/ui/feedback';
import { cn } from '@/lib/util/cn';
import { addDaysToKey, formatDate, formatTime, localDateKey } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Calendar' };
export const dynamic = 'force-dynamic';

const DAYS_SHOWN = 7;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const day =
    typeof params.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : null;
  const view = typeof params.view === 'string' ? params.view : null;
  const date = typeof params.date === 'string' && isDateKey(params.date) ? params.date : null;
  return (
    <PageShell>
      <PageHeader
        title="Calendar"
        subtitle="Nick's calendar, live, by day, week or month. Every event says whether it is a meeting or a block, and why. Meetings ping his phone 5 minutes before; blocks never do."
      />
      <Suspense
        key={`${view ?? ''}|${day ?? date ?? 'today'}`}
        fallback={<SkeletonText lines={10} />}
      >
        <CalendarBody day={day} view={view} date={date} />
      </Suspense>
    </PageShell>
  );
}

/**
 * Which calendar to show. The Day, Week and Month views are the default
 * (D-069, after the parity check matched Nick's real calendar): the person's
 * saved view, Week to start with (a phone opens on Day, in the browser). The
 * "New calendar" switch turned off, remembered per person, keeps the day
 * list instead; an address that names a view (?view=day|week|month) opens it
 * either way, and ?view=list, or an old ?day= link, is the day list.
 */
async function CalendarBody({
  day,
  view,
  date,
}: {
  day: string | null;
  view: string | null;
  date: string | null;
}) {
  const auth = await requireAuth();
  const prefs = await readCalendarPrefs(getStore(), auth.organizationId, auth.userId);
  const named = CALENDAR_VIEWS.includes(view as CalendarViewKind)
    ? (view as CalendarViewKind)
    : null;
  const useViews = named !== null || (view !== 'list' && day === null && prefs.preview);
  if (!useViews) {
    return <CalendarContent day={day} previewView={prefs.view} viewsDefault={prefs.preview} />;
  }
  return <NewCalendar view={named ?? prefs.view} date={date} shown={prefs.shown} />;
}

async function NewCalendar({
  view,
  date,
  shown,
}: {
  view: CalendarViewKind;
  date: string | null;
  shown: Record<string, boolean>;
}) {
  const auth = await requireAuth();
  const tz = auth.profile.timezone;
  const today = localDateKey(new Date(), tz);
  const dateKey = date ?? today;
  const store = getStore();
  // Day view reads its whole week, so stepping through the week reads nothing more.
  const window = viewRange(view === 'day' ? 'week' : view, dateKey);
  const [initial, found] = await Promise.all([
    readCalendarRange(store, auth.organizationId, {
      from: window.from,
      to: window.to,
      timeZone: tz,
      ownEmail: auth.profile.email,
      shown,
    }),
    calendarSource(store, auth.organizationId, auth.profile.email),
  ]);
  const access = found.ok
    ? calendarEditAccess(found.source)
    : { allowed: false, reason: 'Connect Google in Settings first.', demo: false };
  return (
    <CalendarViews
      initial={initial}
      view={view}
      date={dateKey}
      today={today}
      timeZone={tz}
      shown={shown}
      ownEmails={found.ok ? found.source.ownEmails : [auth.profile.email]}
      mailbox={DEFAULT_MAILBOX}
      editing={access}
      turnOnHref={
        !access.allowed && found.ok && !access.demo
          ? '/api/integrations/google/start?calendar=1'
          : null
      }
      // "Email guests" opens the compose window: Send needs the opt-in grant.
      canSend={found.ok && mailboxCanSend(found.source.integration) && !auth.isDemo}
    />
  );
}

function weekdayShort(dateKey: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );
}

async function CalendarContent({
  day,
  previewView,
  viewsDefault,
}: {
  day: string | null;
  previewView: CalendarViewKind;
  /** The new views open at a plain /calendar, so the day list's own Today link names the list. */
  viewsDefault: boolean;
}) {
  const auth = await requireAuth();
  const tz = auth.profile.timezone;
  const today = localDateKey(new Date(), tz);
  const dateKey = day ?? today;
  const result = await readCalendarDay(getStore(), auth.organizationId, {
    dateKey,
    timeZone: tz,
    ownEmail: auth.profile.email,
  });
  const days = Array.from({ length: DAYS_SHOWN }, (_, i) => addDaysToKey(today, i));
  const meetings = result.entries.filter((e) => e.verdict.meeting).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Day" data-tour="calendar-days" className="flex flex-wrap gap-1">
          {days.map((d, i) => (
            <Link
              key={d}
              href={
                i > 0 ? `/calendar?day=${d}` : viewsDefault ? '/calendar?view=list' : '/calendar'
              }
              aria-current={d === dateKey ? 'date' : undefined}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm',
                d === dateKey
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                  : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {i === 0 ? 'Today' : `${weekdayShort(d)} ${Number(d.slice(8))}`}
            </Link>
          ))}
        </nav>
        <PreviewSwitch
          on={false}
          openHref={`/calendar?view=${previewView}&date=${dateKey}`}
          phoneHref={`/calendar?view=day&date=${dateKey}`}
        />
      </div>

      {result.state === 'not_connected' ? (
        <Notice tone="warn">
          No calendar is connected. Connect Google in Settings › Integrations.
        </Notice>
      ) : result.state === 'error' ? (
        <Notice tone="warn">
          {result.message ?? 'Google Calendar did not answer. Try again.'}
        </Notice>
      ) : (
        <>
          <p className="text-sm text-[var(--fg-muted)]" data-tour="calendar-summary">
            {formatDate(`${dateKey}T12:00:00Z`, 'UTC')} · {meetings}{' '}
            {meetings === 1 ? 'meeting' : 'meetings'} · {result.entries.length - meetings}{' '}
            {result.entries.length - meetings === 1 ? 'block' : 'blocks'}
          </p>
          {result.entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--fg-subtle)]">
              Nothing on the calendar.
            </p>
          ) : (
            <ol className="space-y-2" data-tour="calendar-entries">
              {result.entries.map((entry) => (
                <EntryCard
                  key={`${entry.event.id}-${entry.event.startsAt}`}
                  entry={entry}
                  tz={tz}
                  ownEmail={auth.profile.email}
                />
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  tz,
  ownEmail,
}: {
  entry: CalendarEntry;
  tz: string;
  ownEmail: string;
}) {
  const { event, verdict, inPerson, dossier, prep, recent } = entry;
  // Face to face: where it is first. Join stays, muted, in case Nick dials in
  // after all (his calendar attaches Meet to everything he creates).
  const place = inPerson ? physicalLocation(event) : null;
  const time = event.startsAt
    ? `${formatTime(event.startsAt, tz)}${event.endsAt ? ` – ${formatTime(event.endsAt, tz)}` : ''}`
    : 'All day';
  const people = event.attendees.filter(
    (a) => !a.resource && !a.self && a.email !== ownEmail.toLowerCase(),
  );

  if (!verdict.meeting) {
    return (
      <li>
        <div className="flex items-start gap-3 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm">
          <span className="w-40 shrink-0 whitespace-nowrap text-[var(--fg-muted)] tabular-nums">
            {time}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[var(--fg-muted)]">{event.title}</span>
              <Badge tone="neutral">Block</Badge>
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fg-subtle)]">
              <BellOff className="size-3" aria-hidden /> {verdict.reason}. No ping.
            </p>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li>
      <Card>
        <CardContent className="space-y-2 pt-3.5 pb-3.5">
          <div className="flex items-start gap-3">
            <span className="w-40 shrink-0 text-sm font-medium whitespace-nowrap tabular-nums">
              {time}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{event.title}</span>
                <Badge tone="ok">Meeting</Badge>
              </div>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fg-muted)]">
                <Bell className="size-3" aria-hidden /> {verdict.reason}. Pings 5 min before.
              </p>
              {people.length > 0 ? (
                <p className="mt-1 text-xs break-words text-[var(--fg-subtle)]">
                  {people
                    .map(
                      (p) =>
                        `${p.name ?? p.email}${p.response === 'declined' ? ' (declined)' : ''}`,
                    )
                    .join(', ')}
                </p>
              ) : null}
            </div>
            {place || event.joinUrl ? (
              <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-0.5 text-xs">
                {place ? (
                  <span
                    title={place}
                    className="inline-flex max-w-full items-center gap-1 text-[var(--fg-muted)]"
                  >
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{place}</span>
                  </span>
                ) : null}
                {event.joinUrl ? (
                  <a
                    href={event.joinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:underline',
                      inPerson ? 'text-[var(--fg-muted)]' : 'text-[var(--accent)]',
                    )}
                  >
                    <Video className="size-3.5" aria-hidden /> Join
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="ml-0 space-y-1.5 rounded-md bg-[var(--bg-hover)] p-3 text-sm sm:ml-[10.75rem]">
            {dossier?.oneThing ? (
              <p>
                <span className="font-medium">The one thing to know: </span>
                {dossier.oneThing}
              </p>
            ) : null}
            <p>
              <span className="font-medium">How you got here: </span>
              {dossier?.howYouGotHere ??
                prep ??
                (recent.length
                  ? 'No dossier note for this one yet. The latest emails with them are below.'
                  : 'No dossier note and no recent email with them.')}
            </p>
            {dossier && dossier.worthAsking.length > 0 ? (
              <div>
                <p className="font-medium">Worth asking</p>
                <ul className="list-disc pl-5 text-[var(--fg-muted)]">
                  {dossier.worthAsking.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {recent.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-[var(--fg-muted)]">
                  Latest emails with them
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {recent.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="min-w-0 break-words">
                        {t.subject}
                        {t.at ? (
                          <span className="text-[var(--fg-subtle)]"> · {formatDate(t.at, tz)}</span>
                        ) : null}
                      </span>
                      {/* The thread in Copilot's Inbox, or in Gmail. */}
                      <ThreadLinks
                        id={t.id}
                        mailbox={DEFAULT_MAILBOX}
                        label={t.subject}
                        variant="text"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
