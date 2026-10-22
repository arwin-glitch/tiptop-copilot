import type { EventGuestSource, EventGuestStatus } from '@/lib/types/domain';

/**
 * The host's guest table (D-075): one row shape, the status tabs, filters,
 * search and sort. Pure and isomorphic: the table filters in the browser,
 * and the CSV export applies the same filter on the server.
 */

export interface GuestSessionState {
  status: EventGuestStatus;
  checkedInAt: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface GuestFunnel {
  /** A campaign carrying their personal link was sent. */
  invitedAt: string | null;
  openedAt: string | null;
  /** Their personal page was opened (the view beacon). */
  viewedAt: string | null;
  respondedAt: string | null;
}

/** One guest (or plus-one) as the host's table shows it. Owners only: it carries emails and notes. */
export interface GuestListItem {
  id: string;
  parentId: string | null;
  parentName: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  tags: string[];
  source: EventGuestSource;
  referral: string | null;
  note: string | null;
  answers: Record<string, unknown>;
  sessions: Record<string, GuestSessionState>;
  /** The strongest per-session status. */
  status: EventGuestStatus;
  plusOneIds: string[];
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  recordId: string | null;
  showOnWall: boolean;
  funnel: GuestFunnel;
}

export const GUEST_TABS = [
  'all',
  'going',
  'pending',
  'waitlist',
  'invited',
  'maybe',
  'not_going',
  'declined',
  'checked_in',
] as const;
export type GuestTab = (typeof GUEST_TABS)[number];

export const GUEST_TAB_LABELS: Record<GuestTab, string> = {
  all: 'All',
  going: 'Going',
  pending: 'Pending',
  waitlist: 'Waitlist',
  invited: 'Invited',
  maybe: 'Maybe',
  not_going: 'Not going',
  declined: 'Declined',
  checked_in: 'Checked in',
};

/** The preset host tags (custom ones are allowed too). */
export const PRESET_TAGS = [
  'LP',
  'Co-investor',
  'Founder',
  'Sponsor',
  'Speaker',
  'VIP',
  'Staff',
  'Press',
] as const;

const STATUS_RANK: EventGuestStatus[] = [
  'going',
  'pending',
  'waitlist',
  'maybe',
  'invited',
  'not_going',
  'declined',
];

/** Guest-level status: the strongest of their per-session statuses. */
export function strongestStatus(statuses: readonly EventGuestStatus[]): EventGuestStatus {
  for (const status of STATUS_RANK) if (statuses.includes(status)) return status;
  return 'invited';
}

/** The status that counts for a tab: one session's when filtered to it, else the guest's. */
function statusFor(item: GuestListItem, sessionId: string | null): EventGuestStatus | null {
  if (sessionId) return item.sessions[sessionId]?.status ?? null;
  return item.status;
}

/**
 * Statuses whose tab (and count, and audience) means "in ANY session": a
 * guest Going to the Meeting with a pending Reception request still waits for
 * the host's answer, and must show under Pending. Not going and Declined stay
 * guest-level (not coming to anything).
 */
export const ANY_SESSION_STATUSES: ReadonlySet<EventGuestStatus> = new Set([
  'going',
  'pending',
  'waitlist',
  'maybe',
  'invited',
]);

/**
 * Whether a guest with these per-session statuses is in a "status" audience
 * with no session chosen: any session for Going, Pending, Waitlist, Maybe and
 * Invited; guest-level (not coming to anything) for Not going and Declined.
 */
export function statusAudienceMatch(
  wanted: readonly EventGuestStatus[],
  statuses: readonly EventGuestStatus[],
): boolean {
  if (wanted.includes(strongestStatus(statuses))) return true;
  return statuses.some((s) => ANY_SESSION_STATUSES.has(s) && wanted.includes(s));
}

export function inTab(
  item: GuestListItem,
  tab: GuestTab,
  sessionId: string | null = null,
): boolean {
  if (tab === 'all') return sessionId ? Boolean(item.sessions[sessionId]) : true;
  if (tab === 'checked_in') {
    return sessionId
      ? Boolean(item.sessions[sessionId]?.checkedInAt)
      : Object.values(item.sessions).some((s) => s.checkedInAt);
  }
  if (!sessionId && ANY_SESSION_STATUSES.has(tab)) {
    const states = Object.values(item.sessions);
    // On the list with no session rows yet: their guest-level status counts.
    if (!states.length) return item.status === tab;
    return states.some((s) => s.status === tab);
  }
  return statusFor(item, sessionId) === tab;
}

export interface GuestFilter {
  tab: GuestTab;
  sessionId: string | null;
  tag: string | null;
  source: EventGuestSource | null;
  referral: string | null;
  q: string;
}

export const EMPTY_FILTER: GuestFilter = {
  tab: 'all',
  sessionId: null,
  tag: null,
  source: null,
  referral: null,
  q: '',
};

/** Search: name, email, company, or the email's domain ("@example.com" or "example.com"). */
export function matchesSearch(item: GuestListItem, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^@/, '');
  if (!needle) return true;
  const domain = item.email?.split('@')[1] ?? '';
  return [item.name, item.email ?? '', item.company ?? '', domain, item.parentName ?? ''].some(
    (v) => v.toLowerCase().includes(needle),
  );
}

export function filterGuests(
  items: readonly GuestListItem[],
  filter: GuestFilter,
): GuestListItem[] {
  return items.filter(
    (item) =>
      inTab(item, filter.tab, filter.sessionId) &&
      (!filter.tag || item.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())) &&
      (!filter.source || item.source === filter.source) &&
      (!filter.referral || item.referral === filter.referral) &&
      matchesSearch(item, filter.q),
  );
}

export function tabCounts(
  items: readonly GuestListItem[],
  sessionId: string | null = null,
): Record<GuestTab, number> {
  const out = Object.fromEntries(GUEST_TABS.map((t) => [t, 0])) as Record<GuestTab, number>;
  for (const item of items)
    for (const tab of GUEST_TABS) if (inTab(item, tab, sessionId)) out[tab]++;
  return out;
}

export type GuestSort = 'name' | 'registered' | 'changed' | 'checkin';

function lastCheckin(item: GuestListItem): string {
  return (
    Object.values(item.sessions)
      .map((s) => s.checkedInAt ?? '')
      .sort()
      .at(-1) ?? ''
  );
}

/** Sorted, with each plus-one right after their host when both are shown. */
export function sortGuests(
  items: readonly GuestListItem[],
  sort: GuestSort,
  direction: 'asc' | 'desc' = 'asc',
): GuestListItem[] {
  const key = (i: GuestListItem): string => {
    switch (sort) {
      case 'name':
        return i.name.toLowerCase();
      case 'registered':
        return i.registeredAt ?? i.createdAt;
      case 'changed':
        return i.updatedAt;
      case 'checkin':
        return lastCheckin(i);
    }
  };
  const sign = direction === 'asc' ? 1 : -1;
  const hosts = items
    .filter((i) => !i.parentId || !items.some((h) => h.id === i.parentId))
    .sort((a, b) => sign * key(a).localeCompare(key(b)) || a.createdAt.localeCompare(b.createdAt));
  const out: GuestListItem[] = [];
  for (const h of hosts) {
    out.push(h);
    for (const child of items.filter((i) => i.parentId === h.id)) out.push(child);
  }
  return out;
}

/** Every tag in use, presets first. */
export function tagsInUse(items: readonly GuestListItem[]): string[] {
  const used = new Set(items.flatMap((i) => i.tags));
  const presets = PRESET_TAGS.filter((t) => used.has(t));
  const custom = [...used].filter((t) => !(PRESET_TAGS as readonly string[]).includes(t)).sort();
  return [...presets, ...custom];
}
