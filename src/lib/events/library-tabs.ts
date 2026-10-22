import type { EventDetailTab, EventLibraryTab } from '@/lib/events/contracts';
import type { RecordsPageTabs } from '@/lib/records-tabs';
import type { PageTabDef } from '@/lib/util/page-tabs';

/**
 * The Events tab's two tab bars, as data (D-075): the library at /events and
 * one event at /events/[id]. Kept apart from the pages so Help and the tours
 * read the same labels the bars show. Pure: no React, no server-only imports.
 *
 * Label rules (the same as lib/records-tabs.ts): no label contains a
 * main-navigation name, because Playwright matches accessible names by
 * substring. That is why one event's settings tab is called "Manage": a tab
 * named "Settings" would shadow the Settings link in the menu.
 */

export const EVENTS_LIBRARY_TABS = {
  path: '/events',
  page: 'Events',
  navLabel: 'Event library sections',
  defaultKey: 'upcoming',
  tabs: [
    {
      key: 'upcoming',
      label: 'Upcoming',
      blurb: 'Published events that have not happened yet, soonest first.',
    },
    {
      key: 'drafts',
      label: 'Drafts',
      blurb: 'Events whose page is not live yet. Nothing in a draft is public.',
    },
    {
      key: 'past',
      label: 'Past',
      blurb: 'Events that have ended, and archived ones, newest first.',
    },
    {
      key: 'templates',
      label: 'Templates',
      blurb: 'Events saved as a starting point for the next one.',
    },
  ],
} as const satisfies RecordsPageTabs<EventLibraryTab>;

export const EVENT_DETAIL_TAB_DEFS: readonly PageTabDef<EventDetailTab>[] = [
  {
    key: 'overview',
    label: 'Overview',
    blurb: 'Whether the event is ready, what to do next, and the headcount.',
  },
  {
    key: 'page',
    label: 'Page',
    blurb: 'The event page: open Studio to edit it, see what is live.',
  },
  { key: 'guests', label: 'Guests', blurb: 'Everyone on the list, their status and answers.' },
  {
    key: 'registration',
    label: 'Registration',
    blurb: 'Who can RSVP, sessions, capacity, questions and plus-ones.',
  },
  {
    key: 'messages',
    label: 'Messages',
    blurb: 'Invites, reminders, notices and updates: each one a draft you review and send.',
  },
  { key: 'checkin', label: 'Check-in', blurb: 'The door list and check-in counts on the day.' },
  {
    key: 'sharing',
    label: 'Sharing',
    blurb: 'The share kit, outside editors and staff check-in links.',
  },
  {
    key: 'settings',
    label: 'Manage',
    blurb: 'The link, who can find the page, search and share text, cancel or delete.',
  },
];

export const DEFAULT_EVENT_DETAIL_TAB: EventDetailTab = 'overview';
