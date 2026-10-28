import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowLeft, ExternalLink, Pencil } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getEvent, getEventSessions, EVENTS_MIGRATION_FILE } from '@/lib/services/events';
import { ownerCapabilities } from '@/lib/events/capabilities';
import {
  EVENT_DETAIL_TABS,
  eventPaths,
  type EventDetailTab,
  type EventPanelProps,
} from '@/lib/events/contracts';
import { DEFAULT_EVENT_DETAIL_TAB, EVENT_DETAIL_TAB_DEFS } from '@/lib/events/library-tabs';
import { formatWhen, statusChip } from '@/lib/events/tab-view';
import { resolveTab, single } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { PageTabs } from '@/components/ui/page-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonText } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { MarkSeen } from '@/components/events/library/activity-dot';
import { CopyLinkButton } from '@/components/events/library/card-actions';
import { OverviewPanel } from '@/components/events/overview/overview-panel';
import { PagePanel } from '@/components/events/overview/page-panel';
import {
  MESSAGE_VIEWS,
  MessagesPanel,
  type MessageView,
} from '@/components/events/messages/messages-panel';
import { SettingsPanel } from '@/components/events/settings/settings-panel';
// The other workstreams' panels (lib/events/contracts.ts, EventPanelProps):
// WS3 Sharing, WS4 Guests, Registration and Check-in.
import { SharingPanel } from '@/components/events/sharing/sharing-panel';
import { GuestsPanel } from '@/components/events/guests/guests-panel';
import { RegistrationPanel } from '@/components/events/registration/registration-panel';
import { CheckinPanel } from '@/components/events/checkin/checkin-panel';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The browser tab names the event. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const auth = await requireAuth();
  if (!ID_RE.test(id)) return { title: 'Event' };
  const found = await getEvent(getStore(), auth.organizationId, id);
  return { title: found.ok ? found.value.title : 'Event' };
}

const BACK = (
  <Link
    href={eventPaths.library()}
    // `dark`: it sits on the page header's band, like the campaign page's back link.
    className="dark mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
  >
    <ArrowLeft className="size-4" aria-hidden="true" />
    Events
  </Link>
);

/**
 * One event (D-075): Overview, Page, Guests, Registration, Messages,
 * Check-in, Sharing and Manage, each a subtab held in the URL (?tab=). The
 * server renders only the open tab. Guests, Registration and Check-in are
 * WS4's panels and Sharing is WS3's, mounted here with EventPanelProps.
 */
export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Params>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const auth = await requireAuth();
  if (!ID_RE.test(id)) notFound();
  const store = getStore();
  const found = await getEvent(store, auth.organizationId, id);
  if (!found.ok) {
    if (found.error.code === 'not_found') notFound();
    return (
      <PageShell>
        {BACK}
        {found.error.code === 'not_configured' ? (
          <NotConfigured
            title="Events are not set up yet"
            description={`The events tables have not been created in the database. Run ${EVENTS_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
            stillWorks="Everything else in Kraken works as before."
            action={null}
          />
        ) : (
          <ErrorState
            title="This event could not be read"
            message={found.error.message}
            stillUsable="Every other page in Kraken."
          />
        )}
      </PageShell>
    );
  }
  const event = found.value;
  const sessionsRead = await getEventSessions(store, auth.organizationId, id);
  const sessions = sessionsRead.ok ? sessionsRead.value : [];
  const tab = resolveTab<EventDetailTab>(query.tab, EVENT_DETAIL_TABS, DEFAULT_EVENT_DETAIL_TAB);
  const now = new Date();
  const chip = statusChip(
    {
      status: event.status,
      visibility: event.visibility,
      access: event.access,
      isTemplate: event.is_template,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
    },
    now,
  );
  const live = event.status === 'published';
  const panelProps: EventPanelProps = {
    event,
    sessions,
    viewer: {
      userId: auth.userId,
      organizationId: auth.organizationId,
      name: auth.profile.full_name?.trim() || auth.profile.email || 'TipTop',
      timeZone: auth.profile.timezone,
      capabilities: ownerCapabilities(),
    },
  };
  const rawView = single(query.view);
  const messageView: MessageView = (MESSAGE_VIEWS as readonly string[]).includes(rawView ?? '')
    ? (rawView as MessageView)
    : 'drafts';

  return (
    <PageShell>
      {BACK}
      <PageHeader
        title={event.title}
        subtitle={formatWhen(event.starts_at, event.ends_at, event.time_zone)}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={chip.tone}>{chip.label}</Badge>
            <span className="text-xs text-[var(--fg-muted)]">/e/{event.slug}</span>
          </div>
        }
        actions={
          <>
            <Button asChild variant="primary" size="sm">
              <Link href={eventPaths.studio(event.id)}>
                <Pencil aria-hidden="true" />
                Open Studio
              </Link>
            </Button>
            {live ? (
              <Button asChild variant="secondary" size="sm">
                <a href={eventPaths.page(event.slug)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  View page
                </a>
              </Button>
            ) : null}
            <CopyLinkButton slug={event.slug} live={live} variant="secondary" />
          </>
        }
      />
      <PageTabs
        label="Event sections"
        path={`/events/${event.id}`}
        tabs={EVENT_DETAIL_TAB_DEFS.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        defaultKey={DEFAULT_EVENT_DETAIL_TAB}
      />
      <MarkSeen eventId={event.id} />
      <Suspense key={`${tab}:${messageView}`} fallback={<SkeletonText lines={8} />}>
        {tab === 'page' ? (
          <PagePanel {...panelProps} />
        ) : tab === 'guests' ? (
          <GuestsPanel {...panelProps} />
        ) : tab === 'registration' ? (
          <RegistrationPanel {...panelProps} />
        ) : tab === 'messages' ? (
          <MessagesPanel {...panelProps} view={messageView} />
        ) : tab === 'checkin' ? (
          <CheckinPanel {...panelProps} />
        ) : tab === 'sharing' ? (
          <SharingPanel {...panelProps} />
        ) : tab === 'settings' ? (
          <SettingsPanel {...panelProps} />
        ) : (
          <OverviewPanel {...panelProps} />
        )}
      </Suspense>
    </PageShell>
  );
}
