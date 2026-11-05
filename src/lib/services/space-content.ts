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
}

export interface SpaceMeeting {
  id: string;
  title: string;
  at: string;
  upcoming: boolean;
  people: string[];
  owner: string;
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
}

const personName = (name: string | null | undefined, email: string) =>
  name?.trim() || email.split('@')[0] || email;

function eventOwner(event: CalendarEvent, who: Contributors): string | null {
  if (who.excludedUsers.has(event.user_id)) return null;
  const extra = who.extra.find((e) => e.userId === event.user_id);
  return extra ? extra.userId : who.primaryOwner;
}

/** Everything in a Space from what Kraken has synced, newest first, hidden items left out. */
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
  return itemsFrom(scan, access.set, hiddenSet(access), who, now);
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
    });
  }
  const nowMs = now.getTime();
  const meetings: SpaceMeeting[] = [];
  for (const event of scan.events) {
    if (!meetingMatches({ title: event.title, attendees: event.attendees }, set)) continue;
    const owner = eventOwner(event, who);
    if (!owner) continue;
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
  return { threads, meetings, notes, hiddenCount };
}

/** Whose an item is, for Hide: null when it is not in the Space at all. */
export async function itemOwner(
  store: DataStore,
  access: SpaceAccess,
  kind: 'email' | 'meeting' | 'note',
  id: string,
): Promise<string | null> {
  const who = await spaceContributors(store, access);
  if (kind === 'email') {
    // A thread from the Emails tab's live search may be older than the scan:
    // it is the primary mailbox's unless it came from a member's own.
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

function countsKey(access: SpaceAccess): string {
  const parts = [
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
  const tasks = await openTasks(
    store,
    viewer.organizationId,
    viewable.map((a) => a.space.id),
  );
  const cards: SpaceCard[] = [];
  for (const access of spaces.value) {
    let counts: SpaceCounts | null = null;
    if (access.canView) {
      const key = countsKey(access);
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
  | { kind: 'email'; at: string; title: string; detail: string; id: string }
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

export interface SpaceEmailRow extends LiveThreadRow {
  owner: string;
  /** Read from a member's own mailbox: it opens in Gmail (the Inbox reads the primary one). */
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
  /** The mailboxes searched, for the chips: the primary first. */
  mailboxes: { key: string; label: string; userId: string }[];
  mailbox: string;
}

/**
 * One page of the Space's mail, searched live in Gmail with the Space's
 * rules (`from:domain OR to:domain OR keyword`). The primary mailbox by
 * default; `mailbox` picks a member's own once they accepted. Read-only.
 */
export async function spaceEmailPage(
  store: DataStore,
  access: SpaceAccess,
  options: { pageToken?: string | null; mailbox?: string | null; now?: Date } = {},
): Promise<SpaceEmailPage> {
  const who = await spaceContributors(store, access);
  const mailboxes = [
    {
      key: 'primary',
      label: who.primary?.account_email ?? 'Main mailbox',
      userId: who.primaryOwner,
    },
    ...who.extra.map((e) => ({
      key: e.integration.id,
      label: e.integration.account_email ?? 'Member mailbox',
      userId: e.userId,
    })),
  ];
  const pick = mailboxes.find((m) => m.key === options.mailbox) ?? mailboxes[0]!;
  const base = { mailboxes, mailbox: pick.key, hidden: 0 };
  const q = gmailQuery(access.set);
  if (!q) return { ...base, state: 'no_rules', rows: [], nextPageToken: null, total: 0 };
  const integration =
    pick.key === 'primary'
      ? who.primary
      : (who.extra.find((e) => e.integration.id === pick.key)?.integration ?? null);
  const page = await searchMailbox(store, access.space.organization_id, integration, q, {
    pageToken: options.pageToken,
    now: options.now,
  });
  const hidden = hiddenSet(access);
  const rows = page.rows.filter((r) => !hidden.has(hiddenKey('email', r.id)));
  return {
    ...base,
    state: page.state,
    message: page.message,
    nextPageToken: page.nextPageToken,
    total: page.total,
    hidden: page.rows.length - rows.length,
    rows: rows.map((r) => ({
      ...r,
      owner: pick.userId,
      mailbox: pick.key === 'primary' ? null : (integration?.account_email ?? null),
      primary: pick.key === 'primary',
    })),
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
  for (const t of items.threads.slice(0, 30)) {
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
