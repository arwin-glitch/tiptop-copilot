import type { Metadata } from 'next';
import { Suspense, type ComponentProps } from 'react';
import { CalendarClock } from 'lucide-react';
import { hasRole, requireAuth } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { inPersonOffered } from '@/lib/booking/config';
import { lastOpenDay, openMonthsAhead } from '@/lib/booking/months';
import {
  AVAILABILITY_VIEWS,
  BOOKING_DEFAULT_TAB,
  BOOKING_PATH,
  BOOKING_SCOPES,
  BOOKING_TAB_KEYS,
  BOOKING_TABS,
} from '@/lib/booking/tabs';
import { calendarSource } from '@/lib/calendar/range-reader';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import {
  BOOKING_NOT_SET_UP,
  bookingHostName,
  listPendingBookingRequests,
  readBookingSettings,
} from '@/lib/services/booking';
import { bookingEditAccess } from '@/lib/services/booking-planner';
import { mailboxCanSend } from '@/lib/services/docsend-follow-up';
import { principalTimeZone } from '@/lib/services/push-alerts';
import { resolveTab } from '@/lib/util/page-tabs';
import { localDateKey } from '@/lib/util/time';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { WebOnly } from '@/components/desktop/desktop-only';
import { desktopVersionHint } from '@/lib/desktop/server';
import { Button } from '@/components/ui/button';
import { Notice, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import {
  BookingRequestsPanel,
  type PanelRequest,
} from '@/components/booking/booking-requests-panel';
import { AvailabilityPanel } from '@/components/booking/tab/availability-panel';
import { BookingsPanel } from '@/components/booking/tab/bookings-panel';
import { CalendarsPanel } from '@/components/booking/tab/calendars-panel';
import { ChatbotSlot } from '@/components/booking/tab/chatbot-slot';
import { OverviewPanel } from '@/components/booking/tab/overview-panel';
import { PlacesPanel } from '@/components/booking/tab/places-panel';
import { ProfilePanel } from '@/components/booking/tab/profile-panel';

export const metadata: Metadata = { title: 'Booking' };
export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

/**
 * The Booking tab (D-078): Nick's booking link, managed in one place, one
 * subtab per section (never a long scroll). Overview, Availability (the
 * month planner and a live preview of what visitors see), Bookings,
 * Profile, Places, Chatbot and Calendars. Moved out of Settings, which now
 * only links here. The link is off until it is turned on; without its
 * tables (the migration not run yet) the page says which file to run.
 */
export default async function BookingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const tab = resolveTab(params.tab, BOOKING_TAB_KEYS, BOOKING_DEFAULT_TAB);
  return (
    <PageShell>
      <PageHeader
        title="Booking"
        subtitle="Nick's booking link: people pick a free time that passes his rules and it goes straight on his calendar. Open the months you want, close days, and see exactly what visitors see."
      />
      <Suspense fallback={<SkeletonText lines={8} />}>
        <BookingBody tab={tab} params={params} />
      </Suspense>
    </PageShell>
  );
}

async function BookingBody({
  tab,
  params,
}: {
  tab: (typeof BOOKING_TAB_KEYS)[number];
  params: Params;
}) {
  const auth = await requireAuth();
  const store = getStore();
  const [settings, hostZone, access, desktopVersion] = await Promise.all([
    readBookingSettings(store, auth.organizationId).catch((error: unknown) => {
      log.warn('Booking settings could not be read', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }),
    principalTimeZone(store, auth.organizationId),
    bookingEditAccess(store, auth.organizationId).catch(() => ({
      allowed: false,
      reason: null,
      demo: false,
      connected: false,
    })),
    desktopVersionHint(),
  ]);
  if (!settings?.available) {
    return <Notice tone="warn">{BOOKING_NOT_SET_UP}</Notice>;
  }
  const { config } = settings;
  const canEdit = hasRole(auth, 'admin');
  const today = localDateKey(new Date(), hostZone);
  const [pending, held] = await Promise.all([
    listPendingBookingRequests(store, auth.organizationId).catch(() => null),
    access.allowed
      ? Promise.resolve(0)
      : store
          .count('booking_requests', auth.organizationId, { eq: { status: 'held' } })
          .catch(() => 0),
  ]);
  const waitingCount = pending?.requests.length ?? 0;
  const linkBase = `${env().appUrl.replace(/\/+$/, '')}/meet/`;

  return (
    <>
      {!access.allowed && !access.demo ? (
        <div
          className="mb-5 flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--warn)]/40 bg-[var(--warn-soft)] p-4"
          role="status"
          data-tour="booking-editing"
        >
          <CalendarClock className="size-5 shrink-0 text-[var(--warn)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Turn on calendar editing so invites go out automatically
            </p>
            <p className="text-sm text-[var(--fg-muted)]" data-testid="held-count">
              {held
                ? `${held} ${held === 1 ? 'booking is' : 'bookings are'} held until then; they go on the calendar by themselves once it is on.`
                : 'Until then, a booking holds its time and goes on the calendar by itself once editing is on.'}
            </p>
          </div>
          {access.connected ? (
            <WebOnly
              serverVersion={desktopVersion}
              fallback={
                <span className="text-sm text-[var(--fg-muted)]">
                  Turn this on from Kraken in your web browser.
                </span>
              }
            >
              <Button asChild variant="primary" size="sm">
                <a href="/api/integrations/google/start?calendar=1">Turn on calendar editing</a>
              </Button>
            </WebOnly>
          ) : (
            <Button asChild variant="secondary" size="sm">
              <a href="/settings?tab=integrations">Connect Google</a>
            </Button>
          )}
        </div>
      ) : null}
      <PageTabs
        label="Booking sections"
        path={BOOKING_PATH}
        tabs={BOOKING_TABS.map((t) => ({
          key: t.key,
          label: t.label,
          ...(t.key === 'bookings' && waitingCount ? { count: waitingCount } : {}),
        }))}
        active={tab}
        defaultKey={BOOKING_DEFAULT_TAB}
      />
      {tab === 'overview' ? (
        <OverviewPanel
          enabled={settings.enabled}
          slug={settings.slug}
          linkBase={linkBase}
          approveFirst={config.approveFirst}
          canEdit={canEdit}
          editing={{ allowed: access.allowed, demo: access.demo, connected: access.connected }}
          profile={{ displayName: config.displayName, title: config.title, bio: config.bio }}
          inPersonOffered={inPersonOffered(config)}
          today={today}
          hostZone={hostZone}
          openMonths={openMonthsAhead(config, today)}
          lastOpenDay={lastOpenDay(config, today)}
        />
      ) : null}
      {tab === 'availability' ? (
        <AvailabilityPanel
          planner={{
            openMonths: config.openMonths,
            closedDates: config.closedDates,
            closedRanges: config.closedRanges,
            dateHours: config.dateHours,
          }}
          hours={{ callWindow: config.callWindow, kindWindows: config.kindWindows }}
          rules={{
            allowGuests: config.allowGuests,
            maxGuests: config.maxGuests,
            weekdays: config.weekdays,
            callBufferMinutes: config.callBufferMinutes,
            inPersonBufferMinutes: config.inPersonBufferMinutes,
            noticeHours: config.noticeHours,
            maxLinkBookingsPerDay: config.maxLinkBookingsPerDay,
            maxMeetingsPerDay: config.maxMeetingsPerDay,
            stackSize: config.stackSize,
            stackGapMinutes: config.stackGapMinutes,
            stackCooldownMinutes: config.stackCooldownMinutes,
            stackLeadMinutes: config.stackLeadMinutes,
          }}
          today={today}
          hostZone={hostZone}
          canEdit={canEdit}
          view={resolveTab(params.view, AVAILABILITY_VIEWS, 'planner')}
          inPersonOffered={inPersonOffered(config)}
        />
      ) : null}
      {tab === 'bookings' ? (
        <BookingsPanel
          scope={resolveTab(params.scope, BOOKING_SCOPES, 'upcoming')}
          hostZone={hostZone}
          canCancel={hasRole(auth, 'member')}
          waitingCount={waitingCount}
          waiting={
            waitingCount && pending ? (
              <Suspense fallback={null}>
                <WaitingDrawer
                  requests={pending.requests}
                  enabled={settings.enabled}
                  slug={settings.slug}
                />
              </Suspense>
            ) : null
          }
        />
      ) : null}
      {tab === 'profile' ? (
        <ProfilePanel
          profile={{
            displayName: config.displayName,
            title: config.title,
            bio: config.bio,
            firmName: config.firmName,
            callLink: config.callLink,
          }}
          photo={config.photo}
          canEdit={canEdit}
        />
      ) : null}
      {tab === 'places' ? (
        <PlacesPanel
          places={{
            homeCity: config.homeCity,
            homeAliases: config.homeAliases,
            places: config.places,
            allowCustomPlace: config.allowCustomPlace,
          }}
          canEdit={canEdit}
        />
      ) : null}
      {tab === 'chatbot' ? <ChatbotSlot initial={config.chatbot} canEdit={canEdit} /> : null}
      {tab === 'calendars' ? (
        <CalendarsPanel choices={config.calendarChoices} canEdit={canEdit} />
      ) : null}
    </>
  );
}

/**
 * The approve-first requests drawer (D-074), as it was on the Calendar tab:
 * Approve re-checks the time, then puts it on the calendar with the
 * requester invited; Decline offers a decline email that sends only on Send.
 */
async function WaitingDrawer({
  requests: rows,
  enabled,
  slug,
}: {
  requests: Awaited<ReturnType<typeof listPendingBookingRequests>>['requests'];
  enabled: boolean;
  slug: string;
}) {
  const auth = await requireAuth();
  const store = getStore();
  const [hostName, found] = await Promise.all([
    bookingHostName(store, auth.organizationId),
    calendarSource(store, auth.organizationId, auth.profile.email),
  ]);
  const access = found.ok ? calendarEditAccess(found.source) : null;
  const requests: PanelRequest[] = rows.map((r) => ({
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
  const props: ComponentProps<typeof BookingRequestsPanel> = {
    requests,
    timeZone: auth.profile.timezone,
    hostName,
    bookingUrl: `${env().appUrl.replace(/\/+$/, '')}/meet/${slug}`,
    enabled,
    turnOnHref:
      found.ok && access && !access.allowed && !access.demo
        ? '/api/integrations/google/start?calendar=1'
        : null,
    canSend: found.ok && mailboxCanSend(found.source.integration) && !auth.isDemo,
  };
  return <BookingRequestsPanel {...props} />;
}
