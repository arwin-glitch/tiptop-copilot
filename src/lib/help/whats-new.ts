/**
 * "What's new" at the top of Help: what changed lately, one plain line each,
 * newest first, each opening its page (or tab), and starting its tour when
 * it has one. Drawn from CHANGELOG.md; refresh it with every wave of changes
 * so Help never trails the app.
 *
 * `page` is the help entry the line belongs to (its icon, and the page the
 * link opens unless `href` names a tab). `tour` is a tour id from the help
 * registry. `soon` marks something built but switched off for now.
 */

export interface WhatsNewItem {
  /** The day it shipped, YYYY-MM-DD. */
  date: string;
  /** The help entry it belongs to (lib/help/registry.ts). */
  page: string;
  /** One line, plain words. */
  text: string;
  /** Opens a tab rather than the page itself. */
  href?: string;
  /** A tour that shows it. */
  tour?: string;
  /** Built, but off for now: shown with a "Coming soon" tag. */
  soon?: true;
}

export const WHATS_NEW: readonly WhatsNewItem[] = [
  {
    date: '2026-10-22',
    page: 'events',
    text: 'Events: event pages with themes, Studio, outside editors, RSVPs, check-in and invite drafts.',
    tour: 'events',
  },
  {
    date: '2026-10-22',
    page: 'booking',
    text: 'Booking tab: the link, months switched on one by one, a live preview and "Why no times?".',
    tour: 'booking',
  },
  {
    date: '2026-10-22',
    page: 'booking',
    text: 'Bookings land at once, with guests and the Zoom link; a held time retries by itself.',
    href: '/booking?tab=bookings',
  },
  {
    date: '2026-10-22',
    page: 'booking',
    text: "Each booking has its own page to reschedule or cancel. Fyxer's extra line comes off.",
    href: '/booking?tab=bookings',
  },
  {
    date: '2026-10-22',
    page: 'booking',
    text: 'A free booking assistant answers from your list; optional AI runs on the Claude plan.',
    href: '/booking?tab=chatbot',
    tour: 'booking-chatbot',
  },
  {
    date: '2026-10-22',
    page: 'portfolio',
    text: 'A public job board for portfolio roles, with logos. Approve first, then View public board.',
    href: '/portfolio?tab=jobs',
    tour: 'jobs',
  },
  {
    date: '2026-10-22',
    page: 'meetings',
    text: 'Copilot Notes: meeting notes Arwin writes for free. Beta, off for now.',
    href: '/meetings?tab=notes',
    soon: true,
  },
  {
    date: '2026-10-22',
    page: 'settings',
    text: 'No money figures where nothing is spent: Settings says "AI cost: $0".',
    href: '/settings?tab=limits',
  },
  {
    date: '2026-10-21',
    page: 'calendar',
    text: 'Calendar is Day, Week and Month, like Google Calendar. The old day list is gone.',
    tour: 'calendar',
  },
  {
    date: '2026-10-21',
    page: 'calendar',
    text: 'Google\'s colour labels, a Key for every look, and "How you got here" on each event.',
    tour: 'calendar',
  },
  {
    date: '2026-10-21',
    page: 'tasks',
    text: 'Tasks go to the mailbox person, and the person filter lists them first.',
  },
  {
    date: '2026-10-21',
    page: 'tasks',
    text: 'Proof check: a hand-ticked task shows "Seen sent", or a nudge after two days.',
    href: '/tasks?view=completed',
  },
  {
    date: '2026-10-21',
    page: 'inbox',
    text: 'Every email link offers two places to read it: Copilot or Gmail.',
  },
  {
    date: '2026-10-21',
    page: 'network',
    text: 'Students & interns, on Network: mentoring asks, programs and intern requests.',
    href: '/network?tab=students',
    tour: 'students',
  },
  {
    date: '2026-10-21',
    page: 'portfolio',
    text: 'Portfolio › Jobs: open roles founders email about, with a blurb to copy.',
    href: '/portfolio?tab=jobs',
  },
  {
    date: '2026-10-21',
    page: 'fund-ii',
    text: 'Campaigns: a photo per person, CC and BCC, and "Who gets what". Photo uploads fixed.',
    href: '/fund-ii?tab=campaigns',
  },
  {
    date: '2026-10-21',
    page: 'meetings',
    text: 'The Week ahead no longer sticks on yesterday; Diagnostics › Feeds watches every scan.',
  },
];
