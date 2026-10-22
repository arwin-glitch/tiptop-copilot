import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { isDateKey, viewRange } from '@/lib/calendar/grid';
import { legacyCalendarHref } from '@/lib/calendar/legacy-links';
import { calendarSource, readCalendarRange } from '@/lib/calendar/range-reader';
import { CALENDAR_VIEWS, type CalendarViewKind } from '@/lib/calendar/range-types';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { getStore } from '@/lib/runtime';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';
import { mailboxCanSend } from '@/lib/services/docsend-follow-up';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { CalendarViews } from '@/components/calendar/calendar-views';
import { BookingShortcut } from '@/components/booking/tab/booking-shortcut';
import { listPendingBookingRequests, readBookingSettings } from '@/lib/services/booking';
import { log } from '@/lib/security/redact';
import { SkeletonText } from '@/components/ui/feedback';
import { localDateKey } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Calendar' };
export const dynamic = 'force-dynamic';

/**
 * The Calendar tab: Day, Week and Month, like Google Calendar, always
 * (D-072): the person's saved view, else Week (a phone opens on Day, in the
 * browser); an address that names a view (?view=day|week|month&date=) opens
 * it. The old day list is retired: its addresses, ?view=list and ?day=, open
 * Day on that date (lib/calendar/legacy-links.ts). The day reader it used
 * stays, for Today, the meeting pings, the event card's context box and the
 * parity check.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const legacy = legacyCalendarHref(params);
  if (legacy) redirect(legacy);
  const view = typeof params.view === 'string' ? params.view : null;
  const date = typeof params.date === 'string' && isDateKey(params.date) ? params.date : null;
  return (
    <PageShell>
      {/* The booking link shortcut sits over the header band's top right,
          out of the flow, so the calendar below never moves for it. */}
      <div className="relative">
        <PageHeader
          title="Calendar"
          subtitle="Nick's calendar, live, by day, week or month, with his Google colour labels. Click an event for its card: whether it is a meeting or a block, why, and how it got there. Meetings ping his phone 5 minutes before; blocks never do."
        />
        <Suspense fallback={null}>
          <BookingSection />
        </Suspense>
      </div>
      <Suspense key={`${view ?? ''}|${date ?? 'today'}`} fallback={<SkeletonText lines={10} />}>
        <CalendarBody view={view} date={date} />
      </Suspense>
    </PageShell>
  );
}

async function CalendarBody({ view, date }: { view: string | null; date: string | null }) {
  const auth = await requireAuth();
  const tz = auth.profile.timezone;
  const store = getStore();
  const prefs = await readCalendarPrefs(store, auth.organizationId, auth.userId);
  const named = CALENDAR_VIEWS.includes(view as CalendarViewKind)
    ? (view as CalendarViewKind)
    : null;
  const shownView = named ?? prefs.view;
  const today = localDateKey(new Date(), tz);
  const dateKey = date ?? today;
  // Day view reads its whole week, so stepping through the week reads nothing more.
  const window = viewRange(shownView === 'day' ? 'week' : shownView, dateKey);
  const [initial, found] = await Promise.all([
    readCalendarRange(store, auth.organizationId, {
      from: window.from,
      to: window.to,
      timeZone: tz,
      ownEmail: auth.profile.email,
      shown: prefs.shown,
    }),
    calendarSource(store, auth.organizationId, auth.profile.email),
  ]);
  const access = found.ok
    ? calendarEditAccess(found.source)
    : { allowed: false, reason: 'Connect Google in Settings first.', demo: false };
  return (
    <CalendarViews
      initial={initial}
      view={shownView}
      date={dateKey}
      today={today}
      timeZone={tz}
      shown={prefs.shown}
      labelFilter={prefs.labelFilter}
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

/**
 * The booking link's shortcut (D-078): a small "Booking link" link over the
 * header to the Booking tab, with how many requests wait for approval (only
 * while Approve first is on). Not shown when the link's tables are missing
 * (the migration not run yet) or anything fails to read.
 */
async function BookingSection() {
  const shortcut = await bookingShortcutProps().catch((error: unknown) => {
    log.warn('The booking link shortcut could not be shown', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  });
  return shortcut ? <BookingShortcut waiting={shortcut.waiting} /> : null;
}

async function bookingShortcutProps(): Promise<{ waiting: number } | null> {
  const auth = await requireAuth();
  const store = getStore();
  const [list, settings] = await Promise.all([
    listPendingBookingRequests(store, auth.organizationId),
    readBookingSettings(store, auth.organizationId),
  ]);
  if (!list.available || !settings.available) return null;
  return { waiting: list.requests.length };
}
