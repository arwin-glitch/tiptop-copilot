import type { PageTabDef } from '@/lib/util/page-tabs';

/**
 * The Booking tab's subtabs (D-078), as data: the page's tab bar and the
 * help centre read the same labels. One section per subtab, never a long
 * scroll. The bare /booking opens on Overview.
 */

export const BOOKING_TAB_KEYS = [
  'overview',
  'availability',
  'bookings',
  'profile',
  'places',
  'chatbot',
  'calendars',
] as const;
export type BookingTabKey = (typeof BOOKING_TAB_KEYS)[number];

export const BOOKING_PATH = '/booking';
export const BOOKING_DEFAULT_TAB: BookingTabKey = 'overview';

export const BOOKING_TABS: readonly PageTabDef<BookingTabKey>[] = [
  {
    key: 'overview',
    label: 'Overview',
    blurb: 'The link, on or off, instant or approve first, and what is missing.',
  },
  {
    key: 'availability',
    label: 'Availability',
    blurb: 'Switch each month on or off, close days, set hours, rules and guests; live preview.',
  },
  {
    key: 'bookings',
    label: 'Bookings',
    blurb: 'Who booked, when and where, moves and cancellations. "Booking…" books itself.',
  },
  { key: 'profile', label: 'Profile', blurb: 'The name, photo and video link the page shows.' },
  { key: 'places', label: 'Places', blurb: 'Home city and the places he meets people.' },
  {
    key: 'chatbot',
    label: 'Chatbot',
    blurb: 'Arwin on the page: books times and answers from your list. Free.',
  },
  { key: 'calendars', label: 'Calendars', blurb: 'Which calendars block his time.' },
];

/** Inside Availability: the planner, the hours, the rules (`?tab=availability&view=`). */
export const AVAILABILITY_VIEWS = ['planner', 'hours', 'rules'] as const;
export type AvailabilityView = (typeof AVAILABILITY_VIEWS)[number];

/** Inside Bookings (`?tab=bookings&scope=`), matching the bookings API's scopes. */
export const BOOKING_SCOPES = ['upcoming', 'past', 'messages'] as const;
export type BookingScope = (typeof BOOKING_SCOPES)[number];
