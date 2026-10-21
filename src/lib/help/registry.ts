import {
  DEALS_TABS,
  FUND_II_TABS,
  KNOWLEDGE_TABS,
  MEETINGS_TABS,
  NETWORK_TABS,
  PORTFOLIO_TABS,
  UPDATES_TABS,
  type RecordsPageTabs,
} from '@/lib/records-tabs';
import { tabHref } from '@/lib/util/page-tabs';
import { GRAND_TOUR_ID, navTourId } from '@/lib/help/tour-ids';

/**
 * The help centre and the guided tours, as data: one entry per page in the
 * main navigation plus the Ask Arwin widget. The /help page draws its cards
 * from this, and the tour engine (components/help/tour-host.tsx) walks the
 * steps, so the two never disagree about what a page holds.
 *
 * Every step points at a `data-tour` attribute on a real element. A step
 * whose element is not on screen (an empty state, a phone layout, a closed
 * section) is skipped, so a tour never stalls on a missing piece. The unit
 * test checks that every target here exists somewhere in the code.
 *
 * Copy rules, for a reader who does not want to read: a step title is five
 * words at most, a body twenty at most, plain words, no jargon.
 */

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TourStep {
  /** The `data-tour` value of the element to spotlight. */
  target: string;
  title: string;
  body: string;
  /** Where the card sits beside the target on a wide screen. */
  placement: TourPlacement;
  /** One stop on the 2-minute tour of every page. */
  grand?: true;
  /**
   * Stands in for the page's `grand` stop on the 2-minute tour when that
   * stop's target is not on the page: Today without Top priorities shows its
   * glance cards instead. The two must render together, in one streamed
   * section, so the stand-in is never taken while the usual stop is loading.
   */
  grandStandIn?: true;
}

export interface HelpSubtab {
  key: string;
  label: string;
  /** One plain line on what it holds (the tooltip on the help card). */
  blurb: string;
  /** Opens the page on that tab, when the tab has its own URL. */
  href?: string;
}

/**
 * One shape in a page's mini-preview: a rough sketch of where the main things
 * sit, on a 24 by 16 grid beside a little navigation rail. `pin` names a tour
 * target; the sketch numbers it by that step's place in the tour.
 */
export interface SketchBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: 'band' | 'title' | 'action' | 'card' | 'line' | 'chip' | 'tabs' | 'check' | 'gold' | 'pane';
  pin?: string;
}

export interface HelpPage {
  id: string;
  name: string;
  /** The page itself; null for the widget, whose tour runs on whatever page is open. */
  href: string | null;
  /** One line on what the page is for. */
  purpose: string;
  /** Its subtabs or views, when it has any. */
  subtabs: readonly HelpSubtab[];
  steps: readonly TourStep[];
  sketch: readonly SketchBlock[];
}

/* ------------------------------------------------------------- helpers */

function recordsSubtabs(config: RecordsPageTabs): HelpSubtab[] {
  return config.tabs.map((t) => ({
    key: t.key,
    label: t.label,
    blurb: t.blurb,
    href: tabHref(config.path, t.key, config.defaultKey),
  }));
}

/** The step on a Records page's subtab bar, worded from the bar's own labels. */
function subtabStep(config: RecordsPageTabs): TourStep {
  const labels = config.tabs.map((t) => t.label).join(' · ');
  const full = `${labels}. Tap one to switch.`;
  return {
    target: 'subtabs',
    title: 'Switch sections',
    // A long bar drops the hint rather than break the twenty-word rule.
    body: full.split(/\s+/).length <= 20 ? full : `${labels}.`,
    placement: 'bottom',
  };
}

/** The first step of every page tour: where the page lives in the menu. */
function navStep(href: string, title: string, body: string): TourStep {
  return { target: navTourId(href), title, body, placement: 'right' };
}

/** The forest-green header band with the page title, and an action button. */
function header(actionPin?: string): SketchBlock[] {
  return [
    { x: 0, y: 0, w: 24, h: 3, tone: 'band' },
    { x: 1, y: 1, w: 7, h: 1, tone: 'title' },
    ...(actionPin
      ? [{ x: 18, y: 0.9, w: 5, h: 1.2, tone: 'action' as const, pin: actionPin }]
      : []),
  ];
}

/** A Records page's subtab bar under the header. */
const TABS_BAR: SketchBlock = { x: 1, y: 3.8, w: 15, h: 1, tone: 'tabs', pin: 'subtabs' };

/** A few text lines inside a card, starting at (x, y). */
function lines(x: number, y: number, w: number, count: number): SketchBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    x,
    y: y + i * 1.4,
    w: i % 2 === 0 ? w : w * 0.7,
    h: 0.6,
    tone: 'line' as const,
  }));
}

/* --------------------------------------------------------------- pages */

export const HELP_PAGES: readonly HelpPage[] = [
  {
    id: 'today',
    name: 'Today',
    href: '/today',
    purpose: "Your day on one screen: top priorities, intros you owe, and what's next.",
    subtabs: [],
    steps: [
      navStep(
        '/today',
        'Start here each day',
        'Today opens first. Everything that needs you, on one screen.',
      ),
      {
        target: 'today-priorities',
        title: 'Your top priorities',
        body: 'What to do first, ranked, with why. Updated by the morning brief and afternoon checkpoint.',
        placement: 'bottom',
        grand: true,
      },
      {
        target: 'today-glance',
        title: 'Your day at a glance',
        body: "Intros you owe and what's coming up. Do now joins them until today's priorities arrive.",
        placement: 'bottom',
        grandStandIn: true,
      },
      {
        target: 'glance-tick',
        title: 'Tick it off',
        body: "Tick a line when it's done. It folds away, and Undo shows for 8 seconds.",
        placement: 'bottom',
      },
      {
        target: 'page-actions',
        title: 'Quick actions',
        body: 'Ask about today, refresh the outlook, or add a follow-up.',
        placement: 'bottom',
      },
      {
        target: 'today-sections',
        title: 'Everything else, folded',
        body: 'Tasks, meetings, email and deals. Tap a heading to open it.',
        placement: 'top',
      },
    ],
    sketch: [
      ...header('page-actions'),
      { x: 1, y: 3.8, w: 22, h: 4.4, tone: 'card', pin: 'today-priorities' },
      ...lines(2, 4.6, 14, 3),
      { x: 17, y: 4.6, w: 2.5, h: 0.6, tone: 'chip' },
      { x: 1, y: 8.8, w: 10.6, h: 3.4, tone: 'card', pin: 'today-glance' },
      { x: 12.4, y: 8.8, w: 10.6, h: 3.4, tone: 'card' },
      { x: 2, y: 9.6, w: 2.5, h: 0.6, tone: 'chip' },
      { x: 13.4, y: 9.6, w: 2.5, h: 0.6, tone: 'gold' },
      { x: 2, y: 10.8, w: 0.8, h: 0.8, tone: 'check', pin: 'glance-tick' },
      { x: 3.2, y: 10.9, w: 6, h: 0.6, tone: 'line' },
      { x: 13.4, y: 10.9, w: 7, h: 0.6, tone: 'line' },
      { x: 1, y: 12.8, w: 22, h: 3.2, tone: 'card', pin: 'today-sections' },
      ...lines(2, 13.6, 18, 2),
    ],
  },
  {
    id: 'follow-ups',
    name: 'Follow-ups',
    href: '/follow-ups',
    purpose: "Who's waiting on you, who you're waiting on, and recaps drafted after meetings.",
    subtabs: [],
    steps: [
      navStep(
        '/follow-ups',
        "Who's waiting on whom",
        "Follow-ups tracks replies: people waiting on you, and people you're waiting on.",
      ),
      {
        target: 'followups-session',
        title: 'Clear email, one by one',
        body: 'Tap Start. One email at a time, reply already drafted. Nothing sends until you tap Send.',
        placement: 'bottom',
        grand: true,
      },
      {
        target: 'followups-on-you',
        title: 'Waiting on you',
        body: "LPs, founders and co-investors who asked you something and haven't heard back.",
        placement: 'top',
      },
      {
        target: 'followups-waiting',
        title: "You're waiting on",
        body: "You wrote last and haven't heard back yet.",
        placement: 'top',
      },
      {
        target: 'followups-recaps',
        title: 'Meeting recaps',
        body: 'After each meeting, a thank-you and recap is drafted in Gmail for you to check.',
        placement: 'top',
      },
    ],
    sketch: [
      ...header(),
      { x: 1, y: 4, w: 22, h: 2.6, tone: 'card', pin: 'followups-session' },
      { x: 18, y: 4.8, w: 4, h: 1, tone: 'action' },
      ...lines(2, 4.8, 10, 2),
      { x: 1, y: 7.4, w: 10.5, h: 0.8, tone: 'title', pin: 'followups-on-you' },
      ...lines(1, 8.8, 10, 3),
      { x: 12.5, y: 7.4, w: 10.5, h: 0.8, tone: 'title', pin: 'followups-waiting' },
      ...lines(12.5, 8.8, 10, 3),
      { x: 1, y: 13, w: 10.5, h: 0.8, tone: 'title', pin: 'followups-recaps' },
      ...lines(1, 14.3, 10, 1),
    ],
  },
  {
    id: 'tasks',
    name: 'Tasks',
    href: '/tasks',
    purpose: 'Everything you owe someone, by due date. Tick to finish, or snooze.',
    subtabs: [
      {
        key: 'todo',
        label: 'To do',
        blurb: 'Open tasks: overdue, due today, upcoming.',
        href: '/tasks',
      },
      {
        key: 'snoozed',
        label: 'Snoozed',
        blurb: 'Tasks put off until later, soonest back first.',
        href: '/tasks?view=snoozed',
      },
      {
        key: 'completed',
        label: 'Completed',
        blurb: 'What got done, by day, with Reopen.',
        href: '/tasks?view=completed',
      },
    ],
    steps: [
      navStep('/tasks', 'Your to-do list', 'Tasks holds what you owe someone, with due dates.'),
      {
        target: 'tasks-tabs',
        title: 'Open, snoozed, done',
        body: "Switch between what's still open, what's snoozed and what's finished.",
        placement: 'bottom',
      },
      {
        target: 'tasks-list',
        title: 'What you owe',
        body: 'Overdue first, then due today, then upcoming. Tap a title to open its deal or company.',
        placement: 'top',
        grand: true,
      },
      {
        target: 'task-controls',
        title: 'Finish or snooze',
        body: 'Tick to complete, or snooze for three days. Undo is offered each time.',
        placement: 'left',
      },
      {
        target: 'page-actions',
        title: 'Add a reminder',
        body: 'New follow-up creates a task with a due date.',
        placement: 'bottom',
      },
    ],
    sketch: [
      ...header('page-actions'),
      { x: 1, y: 3.8, w: 10, h: 1, tone: 'tabs', pin: 'tasks-tabs' },
      { x: 1, y: 5.8, w: 22, h: 9.4, tone: 'card', pin: 'tasks-list' },
      ...lines(2, 6.8, 14, 5),
      { x: 19.5, y: 6.7, w: 0.9, h: 0.9, tone: 'check', pin: 'task-controls' },
      { x: 21, y: 6.7, w: 0.9, h: 0.9, tone: 'check' },
      { x: 19.5, y: 9.5, w: 0.9, h: 0.9, tone: 'check' },
      { x: 21, y: 9.5, w: 0.9, h: 0.9, tone: 'check' },
    ],
  },
  {
    id: 'deals',
    name: 'Deals',
    href: '/deals',
    purpose: "Every company pitching you, by stage, plus Affinity's pipeline and sourcing lists.",
    subtabs: recordsSubtabs(DEALS_TABS),
    steps: [
      navStep(
        '/deals',
        'Every pitch, one place',
        'Deals lists every company pitching you, by stage.',
      ),
      subtabStep(DEALS_TABS),
      {
        target: 'deals-status',
        title: 'Deal sorter',
        body: 'When the deal sorter last checked your mail, and what it added.',
        placement: 'bottom',
      },
      {
        target: 'deals-filters',
        title: 'Search and filter',
        body: 'Type a company name, or tap a stage to narrow the list.',
        placement: 'bottom',
      },
      {
        target: 'deals-layout',
        title: 'Table or board',
        body: 'Flip between a table and a board by stage. Your pick is remembered.',
        placement: 'right',
      },
      {
        target: 'deals-pipeline',
        title: 'Your pipeline',
        body: 'Every deal with its stage and fit. Tap a company for the full deal page.',
        placement: 'top',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      TABS_BAR,
      { x: 1, y: 5.3, w: 22, h: 0.8, tone: 'line', pin: 'deals-status' },
      { x: 1, y: 6.8, w: 8, h: 1, tone: 'card', pin: 'deals-filters' },
      { x: 10, y: 6.9, w: 2.5, h: 0.8, tone: 'chip' },
      { x: 13, y: 6.9, w: 2.5, h: 0.8, tone: 'chip' },
      { x: 16, y: 6.9, w: 2.5, h: 0.8, tone: 'chip' },
      { x: 1, y: 8.6, w: 4, h: 0.9, tone: 'tabs', pin: 'deals-layout' },
      { x: 1, y: 10.4, w: 5, h: 4.8, tone: 'card', pin: 'deals-pipeline' },
      { x: 6.7, y: 10.4, w: 5, h: 4.8, tone: 'card' },
      { x: 12.4, y: 10.4, w: 5, h: 4.8, tone: 'card' },
      { x: 18.1, y: 10.4, w: 4.9, h: 4.8, tone: 'card' },
    ],
  },
  {
    id: 'inbox',
    name: 'Inbox',
    href: '/inbox',
    purpose: 'Your Gmail, live. Read, reply, archive, star and label without leaving.',
    subtabs: [
      { key: 'primary', label: 'Primary', blurb: 'The main inbox, as in Gmail.' },
      { key: 'other', label: 'Other tabs', blurb: 'Promotions, Updates and the other Gmail tabs.' },
      { key: 'starred', label: 'Starred', blurb: 'Everything starred.' },
      { key: 'sent', label: 'Sent', blurb: 'What went out.' },
    ],
    steps: [
      navStep(
        '/inbox',
        'Your Gmail, live',
        'Inbox is your Gmail: read, reply, archive, star and label right here.',
      ),
      {
        target: 'inbox-tabs',
        title: 'Mail folders',
        body: 'Primary, Other tabs, Starred and Sent, one tap each.',
        placement: 'bottom',
      },
      {
        target: 'inbox-search',
        title: 'Search all mail',
        body: 'Search works like Gmail, for example from:jane or has:attachment.',
        placement: 'bottom',
      },
      {
        target: 'inbox-list',
        title: 'Conversations',
        body: 'Tap a thread to read it. Star, label or archive straight from the row.',
        placement: 'right',
        grand: true,
      },
      {
        target: 'inbox-reading',
        title: 'Read and reply',
        body: 'The open email shows here. A reply sends only when you tap Send.',
        placement: 'left',
      },
      {
        target: 'inbox-compose',
        title: 'Write a new email',
        body: 'Compose starts a fresh email. Nothing sends until you tap Send.',
        placement: 'bottom',
      },
    ],
    sketch: [
      ...header(),
      { x: 1, y: 3.8, w: 3, h: 1, tone: 'action', pin: 'inbox-compose' },
      { x: 4.6, y: 3.8, w: 7, h: 1, tone: 'tabs', pin: 'inbox-tabs' },
      { x: 12.4, y: 3.8, w: 10.6, h: 1, tone: 'card', pin: 'inbox-search' },
      { x: 1, y: 5.8, w: 8.6, h: 9.4, tone: 'card', pin: 'inbox-list' },
      ...lines(1.8, 6.8, 7, 5),
      { x: 10.4, y: 5.8, w: 12.6, h: 9.4, tone: 'pane', pin: 'inbox-reading' },
      ...lines(11.4, 7, 10, 3),
    ],
  },
  {
    id: 'calendar',
    name: 'Calendar',
    href: '/calendar',
    purpose: 'Today and the days ahead. Every entry marked meeting or block.',
    subtabs: [],
    steps: [
      navStep('/calendar', 'Your calendar, live', 'Calendar shows each day, meeting by meeting.'),
      {
        target: 'calendar-days',
        title: 'Pick a day',
        body: 'Today and the days ahead. Tap one to see it.',
        placement: 'bottom',
      },
      {
        target: 'calendar-summary',
        title: 'The day in numbers',
        body: 'How many real meetings and how many blocks the day holds.',
        placement: 'bottom',
      },
      {
        target: 'calendar-entries',
        title: 'Meetings and blocks',
        body: 'Each entry says meeting or block, and why. Meetings ping your phone 5 minutes before.',
        placement: 'top',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      { x: 1, y: 3.8, w: 2.6, h: 1, tone: 'action', pin: 'calendar-days' },
      { x: 4, y: 3.8, w: 2.6, h: 1, tone: 'chip' },
      { x: 7, y: 3.8, w: 2.6, h: 1, tone: 'chip' },
      { x: 10, y: 3.8, w: 2.6, h: 1, tone: 'chip' },
      { x: 1, y: 5.8, w: 9, h: 0.6, tone: 'line', pin: 'calendar-summary' },
      { x: 1, y: 8, w: 22, h: 2.2, tone: 'card', pin: 'calendar-entries' },
      { x: 1, y: 10.6, w: 22, h: 2.2, tone: 'card' },
      { x: 1, y: 13.2, w: 22, h: 2.2, tone: 'card' },
      { x: 2.4, y: 8.7, w: 2, h: 0.7, tone: 'gold' },
    ],
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    href: '/portfolio',
    purpose: 'How each company is doing, what they asked for, and their numbers.',
    subtabs: recordsSubtabs(PORTFOLIO_TABS),
    steps: [
      navStep(
        '/portfolio',
        'Your portfolio',
        'Portfolio shows how each company is doing and what they need.',
      ),
      subtabStep(PORTFOLIO_TABS),
      {
        target: 'portfolio-health',
        title: 'Who needs help',
        body: 'Every company flagged at risk, watch or healthy, with its latest asks.',
        placement: 'top',
        grand: true,
      },
      {
        target: 'page-actions',
        title: 'Add companies',
        body: 'Add a company by hand, or import a sheet.',
        placement: 'bottom',
      },
    ],
    sketch: [
      ...header('page-actions'),
      TABS_BAR,
      { x: 1, y: 5.8, w: 22, h: 9.4, tone: 'card', pin: 'portfolio-health' },
      { x: 2, y: 7, w: 2.4, h: 0.7, tone: 'gold' },
      ...lines(5, 7, 12, 5),
    ],
  },
  {
    id: 'fund-ii',
    name: 'Fund II',
    href: '/fund-ii',
    purpose: 'Your Fund II raise: who read the deck, and every LP conversation.',
    subtabs: recordsSubtabs(FUND_II_TABS),
    steps: [
      navStep(
        '/fund-ii',
        'Fund II raise',
        'Fund II tracks your raise: deck readers and every LP conversation.',
      ),
      subtabStep(FUND_II_TABS),
      {
        target: 'fund-readers',
        title: 'Who read your deck',
        body: 'People who opened your DocSend links, hottest first, each with a suggested follow-up.',
        placement: 'top',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      TABS_BAR,
      { x: 1, y: 5.8, w: 22, h: 3, tone: 'card', pin: 'fund-readers' },
      { x: 1, y: 9.4, w: 22, h: 2.6, tone: 'card' },
      { x: 1, y: 12.6, w: 22, h: 2.6, tone: 'card' },
      { x: 19, y: 6.7, w: 3, h: 1, tone: 'action' },
    ],
  },
  {
    id: 'meetings',
    name: 'Meetings',
    href: '/meetings',
    purpose: 'The week ahead, and every Granola meeting note, searchable.',
    subtabs: recordsSubtabs(MEETINGS_TABS),
    steps: [
      navStep(
        '/meetings',
        'Meetings and notes',
        'Meetings shows the week ahead and every Granola note.',
      ),
      subtabStep(MEETINGS_TABS),
      {
        target: 'meetings-week',
        title: 'The week ahead',
        body: "Coming meetings by day, who's in them, and what to prepare.",
        placement: 'top',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      TABS_BAR,
      { x: 1, y: 5.8, w: 22, h: 9.4, tone: 'card', pin: 'meetings-week' },
      { x: 2, y: 7, w: 3, h: 0.7, tone: 'gold' },
      ...lines(2, 8.3, 16, 2),
      { x: 2, y: 11.2, w: 3, h: 0.7, tone: 'gold' },
      ...lines(2, 12.5, 16, 2),
    ],
  },
  {
    id: 'network',
    name: 'Network',
    href: '/network',
    purpose: 'Intros owed and made, relationships going cold, and everyone you know.',
    subtabs: recordsSubtabs(NETWORK_TABS),
    steps: [
      navStep(
        '/network',
        'Your network',
        'Network tracks intros and the relationships worth keeping warm.',
      ),
      subtabStep(NETWORK_TABS),
      {
        target: 'network-intros',
        title: 'Intros',
        body: 'Intros you owe, intros made, and ones that stalled, each with its email thread.',
        placement: 'top',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      TABS_BAR,
      { x: 1, y: 5.8, w: 22, h: 9.4, tone: 'card', pin: 'network-intros' },
      { x: 2, y: 7, w: 4, h: 0.7, tone: 'chip' },
      ...lines(2, 8.3, 16, 4),
    ],
  },
  {
    id: 'reports',
    name: 'Reports',
    href: '/updates',
    purpose: 'Dealflow reports and company update digests from Slack, in one feed.',
    subtabs: recordsSubtabs(UPDATES_TABS),
    steps: [
      navStep(
        '/updates',
        'Reports from Slack',
        'Reports gathers dealflow reports and update digests in one feed.',
      ),
      subtabStep(UPDATES_TABS),
      {
        target: 'reports-filters',
        title: 'Filter the feed',
        body: 'Show everything, only dealflow, only digests, or a single source.',
        placement: 'bottom',
      },
      {
        target: 'reports-latest',
        title: 'Latest reports',
        body: 'The newest posts from every source, in one list.',
        placement: 'top',
        grand: true,
      },
      {
        target: 'page-actions',
        title: 'Refresh now',
        body: 'Pull the latest from Slack right away.',
        placement: 'bottom',
      },
    ],
    sketch: [
      ...header('page-actions'),
      TABS_BAR,
      { x: 1, y: 5.6, w: 2.5, h: 0.8, tone: 'chip', pin: 'reports-filters' },
      { x: 4, y: 5.6, w: 2.5, h: 0.8, tone: 'chip' },
      { x: 7, y: 5.6, w: 2.5, h: 0.8, tone: 'chip' },
      { x: 1, y: 7.2, w: 22, h: 8, tone: 'card', pin: 'reports-latest' },
      ...lines(2, 8.4, 17, 5),
    ],
  },
  {
    id: 'knowledge',
    name: 'Knowledge',
    href: '/knowledge',
    purpose: 'Thesis docs, memos, pass notes, contacts, and everything carried over from Affinity.',
    subtabs: recordsSubtabs(KNOWLEDGE_TABS),
    steps: [
      navStep(
        '/knowledge',
        'Your knowledge base',
        'Knowledge holds your docs, contacts and everything carried over from Affinity.',
      ),
      subtabStep(KNOWLEDGE_TABS),
      {
        target: 'knowledge-documents',
        title: 'Documents',
        body: 'Every uploaded memo, thesis doc and pass note. The search above covers their full text.',
        placement: 'top',
        grand: true,
      },
      {
        target: 'page-actions',
        title: 'Upload or import',
        body: 'Upload a document or import contacts. Affinity lists and imports have their own tabs.',
        placement: 'bottom',
      },
    ],
    sketch: [
      ...header('page-actions'),
      TABS_BAR,
      { x: 1, y: 5.6, w: 11, h: 1, tone: 'card' },
      { x: 1, y: 7.4, w: 22, h: 7.8, tone: 'card', pin: 'knowledge-documents' },
      ...lines(2, 8.5, 16, 5),
    ],
  },
  {
    id: 'settings',
    name: 'Settings',
    href: '/settings',
    purpose: 'Your thesis, integrations, phone alerts, limits and privacy.',
    subtabs: [
      {
        key: 'thesis',
        label: 'Thesis & scoring',
        blurb: 'What you invest in, and how deals score.',
      },
      { key: 'integrations', label: 'Integrations', blurb: 'Google, and importing from Affinity.' },
      {
        key: 'preferences',
        label: 'Preferences',
        blurb: 'Time zone, phone alerts and the desktop app.',
      },
      { key: 'limits', label: 'Limits & cost', blurb: 'Usage ceilings and spend.' },
      { key: 'data', label: 'Data & privacy', blurb: 'What is stored, and deleting it.' },
    ],
    steps: [
      navStep(
        '/settings',
        'Settings',
        'Settings holds your thesis, integrations, phone alerts and limits.',
      ),
      {
        target: 'settings-help',
        title: 'Help & tours',
        body: 'Replay any tour from here, or open Help in the menu.',
        placement: 'bottom',
      },
      {
        target: 'settings-tabs',
        title: 'One tab per topic',
        body: 'Thesis, integrations, preferences, limits and privacy. Phone alerts live in Preferences.',
        placement: 'bottom',
        grand: true,
      },
    ],
    sketch: [
      ...header(),
      { x: 1, y: 3.8, w: 22, h: 1.6, tone: 'card', pin: 'settings-help' },
      { x: 18.5, y: 4.1, w: 4, h: 1, tone: 'action' },
      { x: 1, y: 6.2, w: 16, h: 1, tone: 'tabs', pin: 'settings-tabs' },
      { x: 1, y: 8, w: 22, h: 7.2, tone: 'card' },
      ...lines(2, 9, 15, 4),
    ],
  },
  {
    id: 'download',
    name: 'Download',
    href: '/download',
    purpose: 'Copilot as an app for your Mac or PC, in its own window.',
    subtabs: [],
    steps: [
      navStep('/download', 'Download', 'Get Copilot as an app for your Mac or Windows PC.'),
      {
        target: 'download-apps',
        title: 'Mac or Windows',
        body: 'Download for your computer. The steps under each button walk through the one-time security check.',
        placement: 'bottom',
        grand: true,
      },
      {
        target: 'download-more',
        title: 'Signing in and updates',
        body: 'The app signs in through your browser once and always shows the latest Copilot. From 0.2.0 it updates itself.',
        placement: 'top',
      },
    ],
    sketch: [
      ...header(),
      { x: 1, y: 3.8, w: 10.5, h: 7, tone: 'card', pin: 'download-apps' },
      { x: 2, y: 5, w: 4, h: 1.2, tone: 'action' },
      ...lines(2, 7, 8, 3),
      { x: 12.5, y: 3.8, w: 10.5, h: 7, tone: 'card' },
      { x: 13.5, y: 5, w: 4, h: 1.2, tone: 'action' },
      ...lines(13.5, 7, 8, 3),
      { x: 1, y: 11.6, w: 22, h: 3.6, tone: 'card', pin: 'download-more' },
      ...lines(2, 12.4, 16, 2),
    ],
  },
  {
    id: 'ask',
    name: 'Ask Arwin',
    href: null,
    purpose: 'The green button on every page. Ask anything, get a short answer.',
    subtabs: [],
    steps: [
      {
        target: 'ask-launcher',
        title: 'Ask Arwin anything',
        body: 'Tap the green button to ask about email, deals, tasks or your calendar. The tour waits while you chat.',
        placement: 'left',
        grand: true,
      },
      {
        target: 'ask-greeting',
        title: 'A quick hello',
        body: 'Tap the bubble to start a chat, or the X to hide it.',
        placement: 'top',
      },
      {
        target: 'today-ask',
        title: 'Ask about today',
        body: 'On Today, one tap asks what needs you. The answer opens in the chat.',
        placement: 'bottom',
      },
      {
        target: 'ask-launcher',
        title: 'Gold dot means news',
        body: 'Close the chat anytime. When an answer lands, "Arwin replied" pops up here and a gold dot stays.',
        placement: 'left',
      },
    ],
    sketch: [
      ...header(),
      ...lines(1, 4.5, 16, 4),
      { x: 1, y: 10, w: 13, h: 5.2, tone: 'card' },
      { x: 13, y: 12.4, w: 6.5, h: 1.2, tone: 'card', pin: 'ask-greeting' },
      { x: 20.4, y: 12, w: 2.4, h: 2.4, tone: 'action', pin: 'ask-launcher' },
    ],
  },
];

/* --------------------------------------------------------------- tours */

/** A tour step with the page it runs on (null: whatever page is open). */
export interface ResolvedStep extends TourStep {
  path: string | null;
  /** The page's name, shown over the step on the card. */
  pageName: string;
  /** 2-minute tour only: the step shown in this one's place when its target is missing. */
  standIn?: ResolvedStep;
}

/** The first stop of the 2-minute tour, before the pages themselves. */
const GRAND_INTRO: ResolvedStep = {
  target: 'main-nav',
  title: 'Every page, one menu',
  body: 'Working pages first, records next, settings last. Tap any name to go there.',
  placement: 'right',
  path: '/today',
  pageName: 'Copilot',
};

/** The last stop: where to come back to. */
const GRAND_OUTRO: ResolvedStep = {
  target: navTourId('/help'),
  title: 'Help is always here',
  body: 'Open Help anytime to replay a tour or see what each page holds.',
  placement: 'right',
  path: null,
  pageName: 'Help',
};

export function helpPage(id: string): HelpPage | undefined {
  return HELP_PAGES.find((p) => p.id === id);
}

/** The page whose tour the "?" button on a page starts: an exact path match. */
export function helpPageForPath(pathname: string): HelpPage | undefined {
  return HELP_PAGES.find((p) => p.href !== null && p.href === pathname);
}

/** The steps of one page's tour, or of the 2-minute tour; empty for an unknown id. */
export function tourSteps(id: string): ResolvedStep[] {
  if (id === GRAND_TOUR_ID) {
    return [
      GRAND_INTRO,
      ...HELP_PAGES.flatMap((page) => {
        const resolve = (step: TourStep): ResolvedStep => ({
          ...step,
          path: page.href,
          pageName: page.name,
        });
        const standIn = page.steps.find((step) => step.grandStandIn);
        return page.steps
          .filter((step) => step.grand)
          .map((step) => ({ ...resolve(step), ...(standIn ? { standIn: resolve(standIn) } : {}) }));
      }),
      GRAND_OUTRO,
    ];
  }
  const page = helpPage(id);
  if (!page) return [];
  return page.steps.map((step) => ({ ...step, path: page.href, pageName: page.name }));
}

/** Whether `id` names a tour that can be started. */
export function isTourId(id: string): boolean {
  return tourSteps(id).length > 0;
}

/**
 * The number a sketch pin shows: the place of that target in the page's own
 * tour, counting from 1. Zero when the target is not a step of the page.
 */
export function pinNumber(page: HelpPage, target: string): number {
  return page.steps.findIndex((s) => s.target === target) + 1;
}
