import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { inboxTaskDetail } from '@/lib/email/thread-links';
import { recordAudit } from '@/lib/security/audit';
import {
  addressMatches,
  gmailQuery,
  meetingMatches,
  nameFromDomain,
  threadMatches,
  type SpaceRuleSet,
} from '@/lib/spaces/rules';
import { readPrincipalId } from '@/lib/tasks/principal';
import type {
  CalendarEvent,
  CrmRecord,
  Deal,
  EmailMessage,
  EmailThread,
  Integration,
  MeetingNote,
  PortfolioCompany,
  Space,
  Task,
} from '@/lib/types/domain';
import { newId, shortHash } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { searchMailbox, type LiveThreadRow } from './inbox-live';
import { recentTeamNotes } from './meetings';
import { isAutomatedAddress, loadCorrespondence } from './network';
import { fundAddresses } from './relationships';
import {
  hiddenKey,
  hiddenSet,
  listMySpaces,
  spaceContributors,
  type Contributors,
  type SpaceAccess,
  type SpaceViewer,
} from './spaces';
import {
  listMemberConnections,
  memberMeetings,
  memberThreads,
  parseMemberItemId,
  readMemberThread,
  type Contributor,
  type MemberMessage,
  type MemberThread,
} from './space-member-mail';
import { normalizeTitle } from './task-ingest';
import { isPersonalDomain, registrableDomain } from './warm-paths';

/**
 * What is in a Space: its emails, meetings and notes, the counts on its
 * card, its action items and the suggestions for more, and the Spaces Kraken
 * suggests making.
 *
 * Cheap by design. The counts, the Meetings tab and the suggestions read the
 * mail, calendar and notes Kraken already synced (one read per organization,
 * kept two minutes and shared by every Space), never Gmail. Only the Emails
 * tab searches Gmail live, one page at a time, through the Inbox's own
 * search and thread cache. Every item a member hid is left out everywhere.
 *
 * Beside the main mailbox, each member who accepted the Space and connected
 * their own Google contributes their matching mail and meetings, read live by
 * space-member-mail.ts (the one module that reads a member's connection) and
 * labelled as theirs (D-081). Nothing of theirs is synced or stored.
 *
 * Read-only toward mail and calendars: nothing here sends, labels, archives
 * or changes anything. Action items are Kraken tasks, added from a person's
 * click.
 */

const TTL_MS = 2 * 60_000;
const SCAN_LIMIT = 2000;
const RECENT_MAX = 8;
const SUGGEST_MIN = 3;
const SUGGEST_MAX = 6;
const NOTE_PREVIEW = 1_200;

/* ------------------------------------------------------------ the scan -- */

interface Scan {
  at: number;
  threads: { thread: EmailThread; messages: EmailMessage[] }[];
  events: CalendarEvent[];
  notes: MeetingNote[];
  own: Set<string>;
}

const cache = processWide('space-content', () => ({
  scans: new Map<string, Scan>(),
  pending: new Map<string, Promise<Scan>>(),
  counts: new Map<string, { at: number; counts: SpaceCounts }>(),
}));

/** Test hook, and what a change made here calls so the next read is fresh. */
export function resetSpaceContentCache(): void {
  cache.scans.clear();
  cache.pending.clear();
  cache.counts.clear();
}

async function buildScan(store: DataStore, organizationId: string, now: Date): Promise<Scan> {
  const [corr, notes, own] = await Promise.all([
    loadCorrespondence(store, organizationId, { limit: SCAN_LIMIT, now, threads: true }).catch(
      () => ({ messages: [], events: [], threads: [] }),
    ),
    recentTeamNotes(store, organizationId).catch(() => [] as MeetingNote[]),
    fundAddresses(store, organizationId).catch(() => [] as string[]),
  ]);
  const byThread = new Map<string, EmailMessage[]>();
  for (const m of corr.messages) {
    const list = byThread.get(m.thread_id) ?? [];
    list.push(m);
    byThread.set(m.thread_id, list);
  }
  const threads = corr.threads
    .map((thread) => ({
      thread,
      messages: (byThread.get(thread.id) ?? []).sort((a, b) => a.sent_at.localeCompare(b.sent_at)),
    }))
    .filter((t) => t.messages.length > 0);
  return { at: now.getTime(), threads, events: corr.events, notes, own: new Set(own) };
}

async function scanFor(store: DataStore, organizationId: string, now: Date): Promise<Scan> {
  const hit = cache.scans.get(organizationId);
  if (hit && now.getTime() - hit.at < TTL_MS && now.getTime() >= hit.at) return hit;
  let pending = cache.pending.get(organizationId);
  if (!pending) {
    pending = buildScan(store, organizationId, now).finally(() =>
      cache.pending.delete(organizationId),
    );
    cache.pending.set(organizationId, pending);
  }
  const scan = await pending;
  cache.scans.set(organizationId, scan);
  if (cache.scans.size > 20) cache.scans.delete(cache.scans.keys().next().value as string);
  return scan;
}

/* ------------------------------------------------------------- items ---- */

/** A thread's id as the Inbox and Gmail know it (the demo mailbox has its own). */
export function emailItemId(thread: Pick<EmailThread, 'id' | 'provider_thread_id'>): string {
  return isDemoMode() ? thread.id.replace(/-/g, '').slice(-16) : thread.provider_thread_id;
}

export interface SpaceThread {
  id: string;
  subject: string;
  at: string;
  /** Who it is with: the newest outside sender's name. */
  who: string;
  messages: number;
  snippet: string;
  /** Whose it is in this Space (the user id), for Hide. */
  owner: string;
  lastFromUs: boolean;
  /**
   * From a member's own mailbox (D-081): their address (Gmail's authuser) and
   * the thread's id there. Null for the main mailbox's, which open in the Inbox.
   */
  member: { mailbox: string | null; threadId: string } | null;
}

export interface SpaceMeeting {
  id: string;
  title: string;
  at: string;
  upcoming: boolean;
  people: string[];
  owner: string;
  /** From a member's own calendar (D-081); false for the main one. */
  fromMember: boolean;
}

export interface SpaceNote {
  id: string;
  title: string;
  at: string;
  provider: MeetingNote['provider'];
  people: string[];
  preview: string;
  /** Kraken's own note opens its meeting page; Granola's has no page of its own. */
  href: string | null;
  owner: string;
}

export interface SpaceItems {
  threads: SpaceThread[];
  meetings: SpaceMeeting[];
  notes: SpaceNote[];
  /** How many of each a member hid. */
  hiddenCount: number;
  /** Contributors whose mailbox could not be read just now (paused or erroring), by user id. */
  unavailable: string[];
  /** Changes whenever whose mailboxes are read changes (caches keyed on a Space use it). */
  sourcesKey: string;
}

const personName = (name: string | null | undefined, email: string) =>
  name?.trim() || email.split('@')[0] || email;

/** The synced calendar is the main mailbox's: its events are the primary owner's. */
function eventOwner(_event: CalendarEvent, who: Contributors): string {
  return who.primaryOwner;
}

interface MemberItems {
  threads: SpaceThread[];
  meetings: SpaceMeeting[];
  unavailable: string[];
}

/**
 * The accepted contributors' own matching mail and meetings (D-081), read by
 * space-member-mail.ts. Only the contributors passed in (accepted members
 * with a connection, worked out on this request) are read; a failure reads
 * as nothing from them, never as an error for the Space.
 */
async function contributorItems(
  store: DataStore,
  set: SpaceRuleSet,
  extra: readonly Contributor[],
  now: Date,
): Promise<MemberItems> {
  const out: MemberItems = { threads: [], meetings: [], unavailable: [] };
  const reads = await Promise.all(
    extra.map(async (c) => {
      const [mail, cal] = await Promise.all([
        memberThreads(store, set, c, now).catch(() => ({ state: 'error' as const, rows: [] })),
        memberMeetings(store, set, c, now).catch(() => ({ state: 'error' as const, rows: [] })),
      ]);
      return { c, mail, cal };
    }),
  );
  for (const { c, mail, cal } of reads) {
    if (mail.state !== 'ok' || cal.state !== 'ok') out.unavailable.push(c.userId);
    for (const t of mail.rows) {
      out.threads.push({
        id: t.itemId,
        subject: t.subject,
        at: t.at,
        who: t.who,
        messages: t.messages,
        snippet: t.snippet,
        owner: t.owner,
        lastFromUs: t.lastFromUs,
        member: { mailbox: t.mailbox, threadId: t.threadId },
      });
    }
    for (const m of cal.rows) {
      out.meetings.push({
        id: m.itemId,
        title: m.title,
        at: m.at,
        upcoming: m.upcoming,
        people: m.people,
        owner: m.owner,
        fromMember: true,
      });
    }
  }
  return out;
}

/**
 * Everything in a Space, newest first, hidden items left out: what Kraken
 * synced from the main mailbox, and each accepted contributor's own matching
 * mail and meetings.
 */
export async function spaceItems(
  store: DataStore,
  access: SpaceAccess,
  now: Date = new Date(),
): Promise<SpaceItems> {
  const org = access.space.organization_id;
  const [scan, who] = await Promise.all([
    scanFor(store, org, now),
    spaceContributors(store, access),
  ]);
  const hidden = hiddenSet(access);
  const base = itemsFrom(scan, access.set, hidden, who, now);
  if (!who.extra.length) return base;
  const more = await contributorItems(store, access.set, who.extra, now);
  let hiddenCount = base.hiddenCount;
  const keep = <T extends { id: string }>(kind: 'email' | 'meeting', rows: T[]) =>
    rows.filter((r) => {
      if (!hidden.has(hiddenKey(kind, r.id))) return true;
      hiddenCount++;
      return false;
    });
  const threads = [...base.threads, ...keep('email', more.threads)].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const meetings = [...base.meetings, ...keep('meeting', more.meetings)].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  return { ...base, threads, meetings, hiddenCount, unavailable: more.unavailable };
}

function itemsFrom(
  scan: Scan,
  set: SpaceRuleSet,
  hidden: Set<string>,
  who: Contributors,
  now: Date,
): SpaceItems {
  let hiddenCount = 0;
  const threads: SpaceThread[] = [];
  for (const { thread, messages } of scan.threads) {
    if (!threadMatches({ subject: thread.subject, messages }, set)) continue;
    const id = emailItemId(thread);
    if (hidden.has(hiddenKey('email', id))) {
      hiddenCount++;
      continue;
    }
    const last = messages.at(-1)!;
    const outside = [...messages]
      .reverse()
      .find((m) => !scan.own.has(m.from_address.toLowerCase()));
    threads.push({
      id,
      subject: thread.subject?.trim() || '(no subject)',
      at: last.sent_at,
      who: outside ? personName(outside.from_name, outside.from_address) : 'You',
      messages: messages.length,
      snippet: last.snippet,
      owner: who.primaryOwner,
      lastFromUs: scan.own.has(last.from_address.toLowerCase()),
      member: null,
    });
  }
  const nowMs = now.getTime();
  const meetings: SpaceMeeting[] = [];
  for (const event of scan.events) {
    if (!meetingMatches({ title: event.title, attendees: event.attendees }, set)) continue;
    const owner = eventOwner(event, who);
    if (hidden.has(hiddenKey('meeting', event.id))) {
      hiddenCount++;
      continue;
    }
    meetings.push({
      id: event.id,
      title: event.title,
      at: event.starts_at,
      upcoming: Date.parse(event.starts_at) > nowMs,
      people: event.attendees
        .filter((a) => !scan.own.has(a.email.toLowerCase()))
        .map((a) => personName(a.name, a.email)),
      owner,
      fromMember: false,
    });
  }
  const notes: SpaceNote[] = [];
  for (const note of scan.notes) {
    if (!meetingMatches({ title: note.title, attendees: note.attendees, text: note.content }, set))
      continue;
    if (hidden.has(hiddenKey('note', note.id))) {
      hiddenCount++;
      continue;
    }
    notes.push({
      id: note.id,
      title: note.title,
      at: note.occurred_at,
      provider: note.provider,
      people: note.attendees
        .filter((a) => !scan.own.has(a.email.toLowerCase()))
        .map((a) => personName(a.name, a.email)),
      preview: note.content.slice(0, NOTE_PREVIEW),
      href:
        note.provider === 'copilot'
          ? `/meetings/${encodeURIComponent(note.meeting_id ?? note.external_id)}`
          : null,
      owner: who.primaryOwner,
    });
  }
  threads.sort((a, b) => b.at.localeCompare(a.at));
  meetings.sort((a, b) => b.at.localeCompare(a.at));
  notes.sort((a, b) => b.at.localeCompare(a.at));
  return { threads, meetings, notes, hiddenCount, unavailable: [], sourcesKey: who.key };
}

/** Whose an item is, for Hide: null when it is not in the Space at all. */
export async function itemOwner(
  store: DataStore,
  access: SpaceAccess,
  kind: 'email' | 'meeting' | 'note',
  id: string,
): Promise<string | null> {
  const who = await spaceContributors(store, access);
  // A contributor's item names them in its id: theirs while they still
  // contribute to this Space (accepted, connected), else nobody's.
  const member = parseMemberItemId(id);
  if (member) {
    if (kind === 'note') return null;
    return who.extra.some((e) => e.userId === member.userId) ? member.userId : null;
  }
  if (kind === 'email') {
    // A thread from the Emails tab's live search may be older than the scan:
    // without a member's prefix it is the main mailbox's.
    return who.primaryOwner;
  }
  const scan = await scanFor(store, access.space.organization_id, new Date());
  if (kind === 'meeting') {
    const event = scan.events.find((e) => e.id === id);
    return event ? eventOwner(event, who) : null;
  }
  return scan.notes.some((n) => n.id === id) ? who.primaryOwner : null;
}

/* ------------------------------------------------------------ counts ---- */

export interface SpaceCounts {
  emails: number;
  meetings: number;
  openItems: number;
  lastActivityAt: string | null;
}

export interface SpaceCard {
  id: string;
  name: string;
  description: string | null;
  isOwner: boolean;
  invited: boolean;
  /** Accepted people besides the owner: 0 means "only you can see it". */
  others: number;
  counts: SpaceCounts | null;
}

function countsKey(access: SpaceAccess, connections: string): string {
  const parts = [
    connections,
    access.space.id,
    access.space.updated_at,
    ...access.rules.map((r) => `${r.kind}:${r.value}`).sort(),
    ...access.hidden.map((h) => hiddenKey(h.item_kind, h.item_id)).sort(),
    ...access.members.map((m) => `${m.user_id}:${m.status}`).sort(),
  ];
  return shortHash(parts.join('|'), 16);
}

async function openTasks(
  store: DataStore,
  organizationId: string,
  spaceIds: string[],
): Promise<Task[]> {
  if (!spaceIds.length) return [];
  return (await store
    .list('tasks', organizationId, { in: { space_id: spaceIds }, eq: { status: 'open' } })
    .catch(() => [])) as Task[];
}

/** The cards on the Spaces tab: one per Space the viewer may see, counts cached briefly. */
export async function spaceCards(
  store: DataStore,
  viewer: SpaceViewer,
  now: Date = new Date(),
): Promise<Result<SpaceCard[]>> {
  const spaces = await listMySpaces(store, viewer);
  if (!spaces.ok) return spaces;
  const viewable = spaces.value.filter((a) => a.canView);
  const [tasks, members] = await Promise.all([
    openTasks(
      store,
      viewer.organizationId,
      viewable.map((a) => a.space.id),
    ),
    listMemberConnections(store, viewer.organizationId).catch(() => ({
      ready: false,
      rows: [] as Integration[],
    })),
  ]);
  // Whose mailboxes are connected, in each card's cache key: a disconnect (or a
  // reconnect, which is a new row) changes the counts at once.
  const connections = members.rows
    .map((r) => `${r.user_id}:${r.id}:${r.status}`)
    .sort()
    .join(',');
  const cards: SpaceCard[] = [];
  for (const access of spaces.value) {
    let counts: SpaceCounts | null = null;
    if (access.canView) {
      const key = countsKey(access, connections);
      const hit = cache.counts.get(key);
      const open = tasks.filter((t) => t.space_id === access.space.id).length;
      if (hit && now.getTime() - hit.at < TTL_MS) {
        counts = { ...hit.counts, openItems: open };
      } else {
        const items = await spaceItems(store, access, now);
        counts = {
          emails: items.threads.length,
          meetings: items.meetings.filter((m) => !m.upcoming).length + items.notes.length,
          openItems: open,
          lastActivityAt: lastActivity(items, now),
        };
        cache.counts.set(key, { at: now.getTime(), counts });
        if (cache.counts.size > 500) cache.counts.clear();
      }
    }
    cards.push({
      id: access.space.id,
      name: access.space.name,
      description: access.space.description,
      isOwner: access.isOwner,
      invited: access.invited,
      others: access.members.filter(
        (m) => m.status === 'accepted' && m.user_id !== access.space.created_by,
      ).length,
      counts,
    });
  }
  return ok(cards);
}

export function lastActivity(items: SpaceItems, now: Date): string | null {
  const nowIso = now.toISOString();
  const dates = [
    items.threads[0]?.at,
    items.meetings.find((m) => m.at <= nowIso)?.at,
    items.notes[0]?.at,
  ].filter((d): d is string => Boolean(d));
  return dates.sort().at(-1) ?? null;
}

export type RecentItem =
  | {
      kind: 'email';
      at: string;
      title: string;
      detail: string;
      id: string;
      member: SpaceThread['member'];
      owner: string;
    }
  | { kind: 'meeting'; at: string; title: string; detail: string; id: string; upcoming: boolean }
  | { kind: 'note'; at: string; title: string; detail: string; id: string; href: string | null };

/** The Overview's recent activity: the newest few of everything, upcoming meetings first. */
export function recentActivity(items: SpaceItems): RecentItem[] {
  const upcoming = items.meetings
    .filter((m) => m.upcoming)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 2)
    .map((m): RecentItem => ({
      kind: 'meeting',
      at: m.at,
      title: m.title,
      detail: m.people.join(', ') || 'Meeting',
      id: m.id,
      upcoming: true,
    }));
  const past: RecentItem[] = [
    ...items.threads.map((t): RecentItem => ({
      kind: 'email',
      at: t.at,
      title: t.subject,
      detail: `${t.who}${t.messages > 1 ? ` · ${t.messages} messages` : ''}`,
      id: t.id,
      member: t.member,
      owner: t.owner,
    })),
    ...items.meetings
      .filter((m) => !m.upcoming)
      .map((m): RecentItem => ({
        kind: 'meeting',
        at: m.at,
        title: m.title,
        detail: m.people.join(', ') || 'Meeting',
        id: m.id,
        upcoming: false,
      })),
    ...items.notes.map((n): RecentItem => ({
      kind: 'note',
      at: n.at,
      title: n.title,
      detail: n.people.join(', ') || 'Meeting note',
      id: n.id,
      href: n.href,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return [...upcoming, ...past].slice(0, RECENT_MAX);
}

/* ------------------------------------------------------------ emails ---- */

export interface SpaceEmailRow {
  /** The id in the Space: Hide uses it (a contributor's carries their user id). */
  itemId: string;
  /** The Gmail thread id in the mailbox it came from. */
  threadId: string;
  who: string;
  subject: string;
  snippet: string;
  at: string | null;
  unread: boolean;
  count: number | null;
  /** Whose it is in this Space (the user id), for Hide and its label. */
  owner: string;
  /**
   * Read from a member's own mailbox (D-081): their address, for Gmail's
   * authuser. Such a row opens in Gmail or the Space's read-only viewer, never
   * the Inbox (which reads the main mailbox alone). Null for the main one.
   */
  mailbox: string | null;
  primary: boolean;
}

export interface SpaceEmailPage {
  state: 'ok' | 'not_connected' | 'error' | 'no_rules';
  rows: SpaceEmailRow[];
  nextPageToken: string | null;
  total: number | null;
  hidden: number;
  message?: string;
  /**
   * The mailboxes, for the chips: All (when members contribute), the main
   * one, then each contributor's (keyed by their user id).
   */
  mailboxes: { key: string; label: string; userId: string | null }[];
  mailbox: string;
  /** On All: the main mailbox's next page, opened on its own chip. */
  morePrimary: string | null;
  /** Contributors whose mailbox could not be read just now. */
  unavailable: string[];
}

function primaryRow(r: LiveThreadRow, owner: string): SpaceEmailRow {
  return {
    itemId: r.id,
    threadId: r.id,
    who: r.who,
    subject: r.subject,
    snippet: r.snippet,
    at: r.at,
    unread: r.unread,
    count: r.count ?? null,
    owner,
    mailbox: null,
    primary: true,
  };
}

function memberRow(t: MemberThread): SpaceEmailRow {
  return {
    itemId: t.itemId,
    threadId: t.threadId,
    who: t.who,
    subject: t.subject,
    snippet: t.snippet,
    at: t.at,
    unread: false,
    count: t.messages,
    owner: t.owner,
    mailbox: t.mailbox,
    primary: false,
  };
}

/**
 * One page of the Space's mail. The main mailbox is searched live in Gmail
 * with the Space's rules (`from:domain OR to:domain OR keyword`), through the
 * Inbox's own search; each accepted contributor's own mailbox through
 * space-member-mail.ts (D-081). "All" (the default once someone contributes)
 * merges the main mailbox's first page with each contributor's matching
 * threads, newest first, each row saying whose mailbox it came from; a chip
 * shows one mailbox alone. Hidden items are left out. Read-only.
 */
export async function spaceEmailPage(
  store: DataStore,
  access: SpaceAccess,
  options: { pageToken?: string | null; mailbox?: string | null; now?: Date } = {},
): Promise<SpaceEmailPage> {
  const now = options.now ?? new Date();
  const who = await spaceContributors(store, access);
  const mailboxes = [
    ...(who.extra.length ? [{ key: 'all', label: 'All', userId: null }] : []),
    {
      key: 'primary',
      label: who.primary?.account_email ?? 'Main mailbox',
      userId: who.primaryOwner,
    },
    ...who.extra.map((e) => ({
      key: e.userId,
      label: e.integration.account_email ?? 'Member mailbox',
      userId: e.userId,
    })),
  ];
  const pick =
    mailboxes.find((m) => m.key === options.mailbox) ??
    (options.pageToken ? mailboxes.find((m) => m.key === 'primary') : null) ??
    mailboxes[0]!;
  const base = {
    mailboxes,
    mailbox: pick.key,
    hidden: 0,
    morePrimary: null,
    unavailable: [] as string[],
  };
  const q = gmailQuery(access.set);
  if (!q) return { ...base, state: 'no_rules', rows: [], nextPageToken: null, total: 0 };
  const hidden = hiddenSet(access);
  const visible = (rows: SpaceEmailRow[]) => {
    const kept = rows.filter((r) => !hidden.has(hiddenKey('email', r.itemId)));
    return { kept, hiddenHere: rows.length - kept.length };
  };

  // One contributor's mailbox alone.
  const contributor = who.extra.find((e) => e.userId === pick.key);
  if (contributor) {
    const read = await memberThreads(store, access.set, contributor, now);
    const { kept, hiddenHere } = visible(read.rows.map(memberRow));
    return {
      ...base,
      state: read.state === 'ok' ? 'ok' : 'error',
      message:
        read.state === 'paused'
          ? 'Their Google connection is paused: they can reconnect it from the Members tab.'
          : read.state === 'error'
            ? 'Their mailbox could not be searched just now. Try again in a minute.'
            : undefined,
      rows: kept,
      hidden: hiddenHere,
      nextPageToken: null,
      total: read.rows.length,
      unavailable: read.state === 'ok' ? [] : [contributor.userId],
    };
  }

  const page = await searchMailbox(store, access.space.organization_id, who.primary, q, {
    pageToken: pick.key === 'primary' ? options.pageToken : null,
    now,
  });
  const primaryRows = page.rows.map((r) => primaryRow(r, who.primaryOwner));
  if (pick.key === 'primary') {
    const { kept, hiddenHere } = visible(primaryRows);
    return {
      ...base,
      state: page.state,
      message: page.message,
      nextPageToken: page.nextPageToken,
      total: page.total,
      hidden: hiddenHere,
      rows: kept,
    };
  }

  // All: the main mailbox's first page and every contributor's matches, merged.
  const reads = await Promise.all(
    who.extra.map((c) =>
      memberThreads(store, access.set, c, now)
        .then((r) => ({ c, r }))
        .catch(() => ({ c, r: { state: 'error' as const, rows: [] as MemberThread[] } })),
    ),
  );
  const merged = [
    ...(page.state === 'ok' ? primaryRows : []),
    ...reads.flatMap(({ r }) => r.rows.map(memberRow)),
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const { kept, hiddenHere } = visible(merged);
  const memberTotal = reads.reduce((n, { r }) => n + r.rows.length, 0);
  return {
    ...base,
    // The Space still shows its contributors' mail when the main search fails.
    state: page.state === 'ok' || kept.length ? 'ok' : page.state,
    message: page.message,
    nextPageToken: null,
    morePrimary: page.state === 'ok' ? page.nextPageToken : null,
    total: page.total !== null ? page.total + memberTotal : null,
    hidden: hiddenHere,
    rows: kept,
    unavailable: reads.filter(({ r }) => r.state !== 'ok').map(({ c }) => c.userId),
  };
}

/* ------------------------------------------------------- action items -- */

export interface SpaceTaskRow {
  id: string;
  title: string;
  detail: string | null;
  dueAt: string | null;
  assignedTo: string | null;
  status: Task['status'];
  suggested: boolean;
}

export async function spaceTasks(store: DataStore, access: SpaceAccess): Promise<SpaceTaskRow[]> {
  const rows = (await store
    .list('tasks', access.space.organization_id, { eq: { space_id: access.space.id } })
    .catch(() => [])) as Task[];
  return rows
    .filter((t) => t.status === 'open' || t.status === 'complete' || t.status === 'snoozed')
    .sort(
      (a, b) =>
        Number(a.status !== 'open') - Number(b.status !== 'open') ||
        (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') ||
        b.created_at.localeCompare(a.created_at),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.detail,
      dueAt: t.due_at,
      assignedTo: t.assigned_to,
      status: t.status,
      suggested: t.source === 'suggested',
    }));
}

export interface ActionSuggestion {
  id: string;
  title: string;
  /** Who it is for, when the note says. */
  owner: string | null;
  from: string;
  detail: string;
}

const CUE =
  /\b(next steps?|action items?|follow[- ]up|to ?do|will send|will share|send over|share the|decision before|needs? to|asked (?:for|us to)|by (?:mon|tues|wednes|thurs|fri)day|by next week|before the board)\b/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s+(.+)$/;
const SECTION = /^\s*#*\s*(action items?|next steps?|follow[- ]ups?|to ?dos?)\s*:?\s*$/i;
const OWNER_LEAD = /^(?:@)?([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?::| to | will )\s*/;

function cleanTitle(text: string): string {
  const t = text
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:\s]+/, '')
    .trim();
  return t.length > 140 ? `${t.slice(0, 137).trimEnd()}...` : t;
}

/** Action items in a note: lines under an "Action items" heading, bullets and sentences with a cue. */
export function actionLines(content: string): { text: string; owner: string | null }[] {
  const out: { text: string; owner: string | null }[] = [];
  let inSection = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      inSection = false;
      continue;
    }
    if (SECTION.test(line)) {
      inSection = true;
      continue;
    }
    const bullet = BULLET.exec(line)?.[1];
    const candidates = bullet
      ? [bullet]
      : inSection
        ? [line]
        : line.split(/(?<=[.!?])\s+/).filter((s) => CUE.test(s));
    for (const c of candidates) {
      if (!inSection && bullet && !CUE.test(c)) continue;
      const owner = OWNER_LEAD.exec(c)?.[1] ?? null;
      const text = cleanTitle(c);
      if (text.length >= 8) out.push({ text, owner });
    }
  }
  return out;
}

const suggestionId = (from: string, title: string) =>
  shortHash(`${from}|${normalizeTitle(title)}`, 16);

/**
 * Action items Kraken suggests for a Space: from its meeting notes (lines
 * under "Action items", bullets and sentences with a cue like "will send")
 * and from threads where the other side wrote last in the past two weeks.
 * Add-only, the way the task routines suggest: nothing becomes a task until a
 * person clicks Add, a suggestion whose title is already a task (open, done
 * or deleted) is not offered, and a dismissed one stays dismissed.
 */
export async function actionSuggestions(
  store: DataStore,
  access: SpaceAccess,
  now: Date = new Date(),
): Promise<ActionSuggestion[]> {
  const items = await spaceItems(store, access, now);
  const titles = new Set(
    ((await store.list('tasks', access.space.organization_id, {}).catch(() => [])) as Task[]).map(
      (t) => normalizeTitle(t.title),
    ),
  );
  const hidden = hiddenSet(access);
  const out: ActionSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Omit<ActionSuggestion, 'id'>) => {
    const key = normalizeTitle(s.title);
    if (titles.has(key) || seen.has(key)) return;
    const id = suggestionId(s.from, s.title);
    if (hidden.has(hiddenKey('suggestion', id))) return;
    seen.add(key);
    out.push({ ...s, id });
  };
  for (const note of items.notes.slice(0, 20)) {
    for (const line of actionLines(note.preview)) {
      push({
        title: line.text,
        owner: line.owner,
        from: `note:${note.id}`,
        detail: `From the meeting note "${note.title}"`,
      });
    }
  }
  const cutoff = now.getTime() - 14 * 24 * 60 * 60_000;
  // Only the main mailbox's threads: a suggestion becomes a workspace task
  // once added, and a member's own mail never leaves the Space (D-081).
  for (const t of items.threads.filter((x) => !x.member).slice(0, 30)) {
    if (t.lastFromUs || Date.parse(t.at) < cutoff) continue;
    push({
      title: `Reply to ${t.who}: ${t.subject}`.slice(0, 140),
      owner: null,
      from: `email:${t.id}`,
      detail: inboxTaskDetail(t.id, t.who),
    });
  }
  return out.slice(0, 12);
}

/** Adds an action item to the Space: a person's own, or a suggestion they accepted. */
export async function addSpaceTask(
  store: DataStore,
  viewer: SpaceViewer,
  access: SpaceAccess,
  input: {
    title: string;
    detail?: string | null;
    dueAt?: string | null;
    assignedTo?: string | null;
    suggested?: boolean;
  },
  now: Date = new Date(),
): Promise<Result<Task>> {
  if (!access.canView) return err('forbidden', 'Accept the invite first.');
  if (viewer.role === 'viewer') return err('forbidden', 'Viewers cannot add action items.');
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) return err('invalid_input', 'An action item needs a title.');
  const allowed = new Set([
    access.space.created_by,
    ...access.members.filter((m) => m.status === 'accepted').map((m) => m.user_id),
  ]);
  if (input.assignedTo && !allowed.has(input.assignedTo)) {
    return err('invalid_input', 'Pick someone in the Space as the owner.');
  }
  const org = viewer.organizationId;
  const stamp = now.toISOString();
  const task: Task = {
    id: newId(),
    organization_id: org,
    title,
    detail: input.detail?.trim().slice(0, 2000) || null,
    status: 'open',
    due_at: input.dueAt ?? null,
    snoozed_until: null,
    deal_id: null,
    portfolio_company_id: null,
    email_message_id: null,
    assigned_to:
      input.assignedTo ?? (await readPrincipalId(store, org).catch(() => null)) ?? viewer.userId,
    created_by: viewer.userId,
    source: input.suggested ? 'suggested' : 'human',
    completed_at: null,
    created_at: stamp,
    updated_at: stamp,
    space_id: access.space.id,
  };
  await store.insert('tasks', task);
  await recordAudit(store, {
    organizationId: org,
    userId: viewer.userId,
    action: 'task.created',
    entityType: 'task',
    entityId: task.id,
    metadata: { source: task.source, space: true, has_due_date: Boolean(task.due_at) },
  });
  return ok(task);
}

/* ------------------------------------------------------ suggested Spaces */

export interface SpaceSuggestion {
  domain: string;
  name: string;
  emails: number;
  meetings: number;
}

/**
 * Spaces worth making, the way Fyxer offered one: companies (by domain) with
 * many threads and meetings in the synced mail, that no Space covers yet.
 * Personal mail, the fund's own addresses and automated senders are left
 * out. Only ever a suggestion: making one is a person's click.
 */
export async function suggestSpaces(
  store: DataStore,
  viewer: SpaceViewer,
  now: Date = new Date(),
): Promise<SpaceSuggestion[]> {
  const org = viewer.organizationId;
  const scan = await scanFor(store, org, now);
  const ownDomains = new Set(
    [...scan.own].map((a) => registrableDomain(a.slice(a.lastIndexOf('@') + 1))),
  );
  const covered = new Set<string>();
  const all = (await store
    .list('space_rules', org, { eq: { kind: 'domain' } })
    .catch(() => [])) as { value: string }[];
  for (const r of all) covered.add(registrableDomain(r.value));

  const domainOf = (raw: string): string | null => {
    const a = raw.trim().toLowerCase();
    if (!a.includes('@') || scan.own.has(a) || isAutomatedAddress(a)) return null;
    const host = a.slice(a.lastIndexOf('@') + 1);
    if (isPersonalDomain(host)) return null;
    const d = registrableDomain(host);
    return ownDomains.has(d) || covered.has(d) ? null : d;
  };
  const emails = new Map<string, number>();
  const meetings = new Map<string, number>();
  for (const { messages } of scan.threads) {
    const domains = new Set<string>();
    for (const m of messages) {
      for (const a of [m.from_address, ...m.to_addresses, ...m.cc_addresses]) {
        const d = domainOf(a);
        if (d) domains.add(d);
      }
    }
    // A blast to many companies says nothing about any one of them.
    if (domains.size > 4) continue;
    for (const d of domains) emails.set(d, (emails.get(d) ?? 0) + 1);
  }
  for (const e of scan.events) {
    if (Date.parse(e.starts_at) > now.getTime()) continue;
    const domains = new Set(e.attendees.map((a) => domainOf(a.email)).filter(Boolean) as string[]);
    if (domains.size > 4) continue;
    for (const d of domains) meetings.set(d, (meetings.get(d) ?? 0) + 1);
  }
  const ranked = [...new Set([...emails.keys(), ...meetings.keys()])]
    .map((domain) => ({
      domain,
      emails: emails.get(domain) ?? 0,
      meetings: meetings.get(domain) ?? 0,
    }))
    .filter((s) => s.emails + s.meetings >= SUGGEST_MIN)
    .sort(
      (a, b) => b.emails + b.meetings - (a.emails + a.meetings) || a.domain.localeCompare(b.domain),
    )
    .slice(0, SUGGEST_MAX);
  if (!ranked.length) return [];
  const names = await namesForDomains(
    store,
    org,
    ranked.map((r) => r.domain),
  );
  return ranked.map((r) => ({ ...r, name: names.get(r.domain) ?? nameFromDomain(r.domain) }));
}

/** Company names Kraken already knows for some domains: CRM, portfolio, deals. */
async function namesForDomains(
  store: DataStore,
  organizationId: string,
  domains: string[],
): Promise<Map<string, string>> {
  const [records, portfolio, deals] = await Promise.all([
    store
      .list('crm_records', organizationId, { in: { domain: domains }, eq: { kind: 'company' } })
      .catch(() => []) as Promise<CrmRecord[]>,
    store
      .list('portfolio_companies', organizationId, { in: { domain: domains } })
      .catch(() => []) as Promise<PortfolioCompany[]>,
    store.list('deals', organizationId, { in: { domain: domains } }).catch(() => []) as Promise<
      Deal[]
    >,
  ]);
  const names = new Map<string, string>();
  for (const row of [...deals, ...records, ...portfolio]) {
    const domain = (row as { domain: string | null }).domain?.toLowerCase();
    const r = row as { name?: string; company_name?: string };
    const name = r.name ?? r.company_name;
    if (domain && name) names.set(domain, name);
  }
  return names;
}

/** Whether an address would land in a Space (for "Make a Space" from a profile). */
export { addressMatches };

/** What a new Space from a company, person or deal starts with. */
export interface SpaceSeed {
  name: string;
  domains: string[];
  emails: string[];
  sourceKind: Space['source_kind'];
  sourceRef: string;
}

/** A Space's starting name and rules from a CRM profile or a deal. */
export async function seedFrom(
  store: DataStore,
  organizationId: string,
  from: { kind: 'record' | 'deal'; id: string },
): Promise<SpaceSeed | null> {
  if (from.kind === 'deal') {
    const deal = (await store
      .get('deals', organizationId, from.id)
      .catch(() => null)) as Deal | null;
    if (!deal) return null;
    return {
      name: deal.company_name,
      domains: deal.domain ? [deal.domain] : [],
      emails: [],
      sourceKind: 'deal',
      sourceRef: deal.id,
    };
  }
  const record = (await store
    .get('crm_records', organizationId, from.id)
    .catch(() => null)) as CrmRecord | null;
  if (!record) return null;
  return {
    name: record.name,
    domains: record.kind === 'company' && record.domain ? [record.domain] : [],
    emails: record.kind === 'person' ? record.emails.slice(0, 10) : [],
    sourceKind: record.kind === 'company' ? 'company' : 'person',
    sourceRef: record.id,
  };
}

/* --------------------------------------------- a contributor's email ---- */

export interface SpaceMemberEmail {
  owner: string;
  mailbox: string | null;
  threadId: string;
  subject: string;
  messages: MemberMessage[];
}

/**
 * One contributor's email for the Space's read-only viewer (D-081): only
 * while they contribute to this Space (accepted, connected), only a thread
 * matching its rules, and never one somebody hid. Anything else reads as not
 * found. Read-only: nothing changes in their Gmail.
 */
export async function spaceMemberEmail(
  store: DataStore,
  access: SpaceAccess,
  itemId: string,
): Promise<Result<SpaceMemberEmail>> {
  const notFound = err('not_found', 'That email is not in this Space.');
  if (!access.canView) return err('forbidden', 'Accept the invite first.');
  const parsed = parseMemberItemId(itemId);
  if (!parsed) return notFound;
  if (hiddenSet(access).has(hiddenKey('email', itemId))) return notFound;
  const who = await spaceContributors(store, access);
  const contributor = who.extra.find((e) => e.userId === parsed.userId);
  if (!contributor) return notFound;
  const thread = await readMemberThread(store, access.set, contributor, parsed.rawId);
  if (!thread.ok) return thread;
  return ok({
    owner: contributor.userId,
    mailbox: contributor.integration.account_email,
    threadId: parsed.rawId,
    subject: thread.value.subject,
    messages: thread.value.messages,
  });
}
