import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Search } from 'lucide-react';
import { requireAuth, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listEvents, EVENTS_MIGRATION_FILE } from '@/lib/services/events';
import { latestGuestActivity } from '@/lib/services/event-overview';
import { EVENTS_LIBRARY_TABS } from '@/lib/events/library-tabs';
import { resolvePageTab } from '@/lib/records-tabs';
import { single, tabHref } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { PageTabs } from '@/components/ui/page-tabs';
import { EmptyState, ErrorState, SkeletonText } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { EventCard } from '@/components/events/library/event-card';
import { StarterGallery } from '@/components/events/library/starter-gallery';
import { starterCards, themeCards } from '@/components/events/library/gallery-data';
import { NewEventDialog } from '@/components/events/new-event-dialog';
import type { EventLibraryTab } from '@/lib/events/contracts';

export const metadata: Metadata = { title: 'Events' };
export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

const EMPTY: Record<EventLibraryTab, { title: string; description: string }> = {
  upcoming: {
    title: 'Nothing upcoming',
    description: 'Published events that have not happened yet show here. Drafts wait in Drafts.',
  },
  drafts: {
    title: 'No drafts',
    description: 'A new event starts here as a private draft until you publish it.',
  },
  past: {
    title: 'Nothing past yet',
    description: 'Events move here once they end, or when you archive one.',
  },
  templates: {
    title: 'No templates yet',
    description: 'Save any event as a template from its ⋯ menu to reuse its page and settings.',
  },
};

/**
 * The Events library (D-075): every event as a card, under Upcoming, Drafts,
 * Past and Templates (held in the URL as ?tab=), with a title search. With no
 * events at all the page is the starter gallery.
 */
export default async function EventsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const auth = await requireAuth();
  const tab = resolvePageTab(EVENTS_LIBRARY_TABS, params);
  const q = (single(params.q) ?? '').trim().slice(0, 140);
  const starters = starterCards();
  const themes = themeCards();
  return (
    <PageShell>
      <PageHeader
        title="Events"
        subtitle="Event pages with their guest lists and invites. Every email to guests is a draft you review and send."
        actions={
          <NewEventDialog starters={starters} themes={themes} timeZone={auth.profile.timezone} />
        }
      />
      <PageTabs
        label={EVENTS_LIBRARY_TABS.navLabel}
        path={EVENTS_LIBRARY_TABS.path}
        tabs={EVENTS_LIBRARY_TABS.tabs.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        defaultKey={EVENTS_LIBRARY_TABS.defaultKey}
      />
      <form
        role="search"
        action="/events"
        method="get"
        className="mb-5 flex max-w-md items-center gap-2"
      >
        {tab !== EVENTS_LIBRARY_TABS.defaultKey ? (
          <input type="hidden" name="tab" value={tab} />
        ) : null}
        <label htmlFor="events-search" className="sr-only">
          Search events by title
        </label>
        <Input
          id="events-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by title"
          maxLength={140}
        />
        <Button type="submit" size="md" variant="secondary" aria-label="Search">
          <Search aria-hidden="true" />
        </Button>
      </form>
      <Suspense key={`${tab}:${q}`} fallback={<SkeletonText lines={8} />}>
        <Library auth={auth} tab={tab} q={q} starters={starters} themes={themes} />
      </Suspense>
    </PageShell>
  );
}

async function Library({
  auth,
  tab,
  q,
  starters,
  themes,
}: {
  auth: AuthContext;
  tab: EventLibraryTab;
  q: string;
  starters: ReturnType<typeof starterCards>;
  themes: ReturnType<typeof themeCards>;
}) {
  const store = getStore();
  const now = new Date();
  const listed = await listEvents(store, auth.organizationId, { tab, search: q || undefined, now });
  if (!listed.ok) {
    if (listed.error.code === 'not_configured') {
      return (
        <NotConfigured
          title="Events are not set up yet"
          description={`The events tables have not been created in the database. Run ${EVENTS_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
          stillWorks="Everything else in Copilot works as before."
          action={null}
        />
      );
    }
    return (
      <ErrorState
        title="Events could not be read"
        message={listed.error.message}
        stillUsable="Every other page in Copilot."
      />
    );
  }
  const events = listed.value;
  if (!events.length) {
    if (q) {
      return (
        <EmptyState
          title={`No events match “${q}”`}
          description="Search looks at event titles on this tab."
          action={{ label: 'Clear the search', href: tabHref('/events', tab, 'upcoming') }}
        />
      );
    }
    // No events anywhere: the starters are the way in.
    const anything = await listEvents(store, auth.organizationId, { now });
    if (anything.ok && anything.value.length === 0) {
      return (
        <StarterGallery starters={starters} themes={themes} timeZone={auth.profile.timezone} />
      );
    }
    return <EmptyState title={EMPTY[tab].title} description={EMPTY[tab].description} />;
  }
  const activity = await latestGuestActivity(
    store,
    auth.organizationId,
    events.map((e) => e.id),
  );
  return (
    <>
      <ul
        aria-label="Events"
        data-tour="events-library"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {events.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            activityAt={activity[event.id] ?? null}
            now={now}
          />
        ))}
      </ul>
      {tab === 'upcoming' ? (
        <p className="mt-4 text-sm text-[var(--fg-muted)]">
          Looking for a draft?{' '}
          <Link href="/events?tab=drafts" className="link-inline">
            Drafts
          </Link>{' '}
          hold every event that is not published yet.
        </p>
      ) : null}
    </>
  );
}
