import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense, type ComponentProps } from 'react';
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
import {
  BookingRequestsPanel,
  type PanelRequest,
} from '@/components/booking/booking-requests-panel';
import { env } from '@/lib/config/env';
import {
  bookingHostName,
  listPendingBookingRequests,
  readBookingSettings,
} from '@/lib/services/booking';
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
      {/* The booking requests button sits over the header band's top right,
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
 * Booking requests from the public booking link (D-074), a button over the
 * header that opens them in a drawer:
 * shown while the link is on or anything is waiting, and not at all when its
 * tables are missing (the migration not run yet) or anything fails to read.
 */
async function BookingSection() {
  const props = await bookingPanelProps().catch((error: unknown) => {
    log.warn('Booking requests could not be shown', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  });
  return props ? <BookingRequestsPanel {...props} /> : null;
}

async function bookingPanelProps(): Promise<ComponentProps<typeof BookingRequestsPanel> | null> {
  const auth = await requireAuth();
  const store = getStore();
  const [list, settings] = await Promise.all([
    listPendingBookingRequests(store, auth.organizationId),
    readBookingSettings(store, auth.organizationId),
  ]);
  if (!list.available || (!settings.enabled && list.requests.length === 0)) return null;
  const [hostName, found] = await Promise.all([
    bookingHostName(store, auth.organizationId),
    calendarSource(store, auth.organizationId, auth.profile.email),
  ]);
  const access = found.ok ? calendarEditAccess(found.source) : null;
  const requests: PanelRequest[] = list.requests.map((r) => ({
    id: r.id,
    type: r.meeting_type,
    kind: r.kind,
    startsAt: r.starts_at,
    visitorZone: r.visitor_time_zone,
    name: r.name,
    email: r.email,
    company: r.company,
    placeName: r.place_name,
    placeArea: r.place_area,
    placeMapUrl: r.place_map_url,
    placeCustom: r.place_custom,
    note: r.note,
    deckUrl: r.deck_url,
    source: r.source,
    createdAt: r.created_at,
  }));
  return {
    requests,
    timeZone: auth.profile.timezone,
    hostName,
    bookingUrl: `${env().appUrl.replace(/\/+$/, '')}/meet/${settings.slug}`,
    enabled: settings.enabled,
    instant: !settings.config.approveFirst,
    turnOnHref:
      found.ok && access && !access.allowed && !access.demo
        ? '/api/integrations/google/start?calendar=1'
        : null,
    canSend: found.ok && mailboxCanSend(found.source.integration) && !auth.isDemo,
  };
}
