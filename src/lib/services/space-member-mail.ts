import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS } from '@/lib/demo/ids';
import { demoMemberMailbox, type DemoMemberThread } from '@/lib/demo/space-member-fixtures';
import { gmailGet } from '@/lib/google/gmail-get';
import { listThreadPage, readThreadFull } from '@/lib/google/gmail-inbox';
import {
  getAccessToken,
  isMemberReadOnlyGrant,
  memberScopesKept,
  revokeAndForget,
  storeTokens,
} from '@/lib/google/oauth';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { gmailQuery, meetingMatches, threadMatches, type SpaceRuleSet } from '@/lib/spaces/rules';
import type { Integration } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';

/**
 * A member's own Google, connected read-only to contribute to Spaces (D-081).
 *
 * THE ONLY MODULE THAT READS A MEMBER CONNECTION. A member connection is an
 * integration row with provider 'google_space' and user_id = that member. Its
 * mail and calendar are read live, here, and only:
 *
 *   - for a Space whose membership row for that member is `accepted` (the
 *     callers pass the Space's contributors, worked out from the membership
 *     rows read on that same request: spaces.ts spaceContributors);
 *   - for items matching that Space's rules (Gmail's search with the rules,
 *     then the same local rule check the synced mail gets);
 *   - shown to that Space's members only (the Space pages check membership).
 *
 * Nothing is ever copied into email_threads, calendar_events or any other
 * table, so the Inbox, Today, Follow-ups, Tasks, Ask Arwin, digests, the
 * routines and search never see it. Every read here is a GET with the
 * read-only grant: nothing sends, labels, archives or changes a member's
 * mail or calendar. A test scans the source for any other reader.
 *
 * What is read is kept a few minutes in this process, keyed per member and
 * connection; leaving or declining a Space takes effect at once (the next
 * request no longer counts them a contributor), and disconnecting deletes the
 * row and forgets everything kept for them.
 *
 * Tokens are stored and opened exactly as the primary's (lib/google/oauth.ts:
 * AES-GCM, bound to the integration id); none ever leaves the server or
 * reaches a log.
 */

export const MEMBER_PROVIDER = 'google_space' as const;

export const MEMBER_NOT_SET_UP =
  'Contributing your own Google needs a database update first. Nothing else changes.';

const THREADS_TTL_MS = 3 * 60_000;
const EVENTS_TTL_MS = 5 * 60_000;
const THREAD_PAGE = 50;
const FETCH_BATCH = 8;
const EVENT_TERMS_MAX = 8;
const EVENTS_PER_TERM = 100;
const PAST_DAYS = 365;
const AHEAD_DAYS = 90;
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** Postgres refusing 'google_space' because the migration that adds it has not run. */
function isMissingEnumValue(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === '22P02') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /invalid input value for enum/i.test(message);
}

/* ------------------------------------------------------------ the rows -- */

/**
 * Every member connection in the organization that is not disconnected.
 * `ready` is false before the migration (nothing can be connected yet).
 */
export async function listMemberConnections(
  store: DataStore,
  organizationId: string,
): Promise<{ ready: boolean; rows: Integration[] }> {
  try {
    const rows = (await store.list('integrations', organizationId, {
      eq: { provider: MEMBER_PROVIDER },
    })) as Integration[];
    return {
      ready: true,
      rows: rows.filter((r) => r.provider === MEMBER_PROVIDER && r.status !== 'disconnected'),
    };
  } catch (error) {
    if (isMissingEnumValue(error)) return { ready: false, rows: [] };
    throw error;
  }
}

export type ContributionStatus = 'connected' | 'paused' | 'none';

/** Connected; Paused (Google stopped answering for it: reconnect); or none. */
export function contributionStatus(row: Integration | null | undefined): ContributionStatus {
  if (!row || row.status === 'disconnected') return 'none';
  return row.status === 'connected' ? 'connected' : 'paused';
}

/** What the browser may know about someone's own connection: never a token, never a scope list. */
export interface MemberConnectionView {
  email: string | null;
  status: ContributionStatus;
  since: string;
}

/** The viewer's own member connection, for Settings and the Space's Members tab. */
export async function myMemberConnection(
  store: DataStore,
  viewer: { organizationId: string; userId: string },
): Promise<{ ready: boolean; connection: MemberConnectionView | null; isMainMailbox: boolean }> {
  const [{ ready, rows }, primary] = await Promise.all([
    listMemberConnections(store, viewer.organizationId).catch(() => ({
      ready: false,
      rows: [] as Integration[],
    })),
    getPrimaryIntegration(store, viewer.organizationId).catch(() => null),
  ]);
  const mine = rows.find((r) => r.user_id === viewer.userId) ?? null;
  return {
    ready,
    isMainMailbox: Boolean(primary && primary.user_id === viewer.userId && !mine),
    connection: mine
      ? { email: mine.account_email, status: contributionStatus(mine), since: mine.created_at }
      : null,
  };
}

/**
 * Stores a member's connection after Google's consent (the OAuth callback's
 * member mode). Refuses a grant with anything beyond the read-only scopes,
 * and the main mailbox's own account (that one is already in every Space).
 * Never touches the primary integration.
 */
export async function saveMemberConnection(
  store: DataStore,
  input: {
    organizationId: string;
    userId: string;
    accountEmail: string | null;
    grantedScopes: string[];
    tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number };
  },
  now: Date = new Date(),
): Promise<Result<Integration>> {
  if (!isMemberReadOnlyGrant(input.grantedScopes)) {
    return err(
      'invalid_input',
      'Google granted more than read-only access, so nothing was connected. Try again and approve only reading mail and calendar.',
    );
  }
  if (!input.accountEmail) {
    return err('provider_unavailable', 'Google did not say which account this is. Try again.');
  }
  const primary = await getPrimaryIntegration(store, input.organizationId).catch(() => null);
  if (primary?.account_email?.toLowerCase() === input.accountEmail.toLowerCase()) {
    return err(
      'invalid_input',
      `${primary.account_email} is the main mailbox: it is already in every Space. Choose your own Google account.`,
    );
  }
  const existing = (await listMemberConnections(store, input.organizationId)).rows.find(
    (r) => r.user_id === input.userId,
  );
  const stamp = now.toISOString();
  const scopes = memberScopesKept(input.grantedScopes);
  const row: Integration = {
    id: existing?.id ?? newId(),
    organization_id: input.organizationId,
    user_id: input.userId,
    provider: MEMBER_PROVIDER,
    kinds: [
      'gmail',
      ...(scopes.some((s) => s.includes('calendar')) ? (['calendar'] as const) : []),
    ],
    account_email: input.accountEmail,
    scopes,
    status: 'connected',
    status_detail: null,
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: null,
    created_at: existing?.created_at ?? stamp,
    updated_at: stamp,
  };
  let saved: Integration;
  try {
    saved = (await store.upsert('integrations', row, ['organization_id', 'provider', 'user_id']))
      .row as Integration;
  } catch (error) {
    if (isMissingEnumValue(error)) return err('not_configured', MEMBER_NOT_SET_UP);
    throw error;
  }
  const stored = await storeTokens(store, saved, input.tokens);
  if (!stored.ok) {
    await store.remove('integrations', input.organizationId, saved.id).catch(() => undefined);
    return stored;
  }
  forgetMember(input.userId);
  await recordAudit(store, {
    organizationId: input.organizationId,
    userId: input.userId,
    action: 'integration.connected',
    entityType: 'integration',
    entityId: saved.id,
    metadata: {
      provider: MEMBER_PROVIDER,
      purpose: 'spaces',
      scopes,
      account_domain: input.accountEmail.split('@')[1] ?? null,
    },
  });
  return ok(saved);
}

/**
 * Disconnects the viewer's own member connection: the grant is revoked at
 * Google (best effort; never in the demo), the stored tokens are deleted and
 * the row with them, and everything kept for them here is forgotten, so
 * their items leave every Space at once. The primary is never touched.
 */
export async function disconnectMemberConnection(
  store: DataStore,
  viewer: { organizationId: string; userId: string },
): Promise<Result<{ revokedRemotely: boolean; wasConnected: boolean }>> {
  const { rows } = await listMemberConnections(store, viewer.organizationId);
  const mine = rows.find((r) => r.user_id === viewer.userId && r.provider === MEMBER_PROVIDER);
  forgetMember(viewer.userId);
  if (!mine) return ok({ revokedRemotely: false, wasConnected: false });
  let revokedRemotely = false;
  if (isDemoMode()) {
    await store.removeWhere('encrypted_provider_tokens', viewer.organizationId, {
      eq: { integration_id: mine.id },
    });
  } else {
    const revoked = await revokeAndForget(store, mine);
    revokedRemotely = revoked.ok && revoked.value.revokedRemotely;
  }
  await store.remove('integrations', viewer.organizationId, mine.id);
  forgetMember(viewer.userId);
  await recordAudit(store, {
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    action: 'integration.disconnected',
    entityType: 'integration',
    entityId: mine.id,
    metadata: { provider: MEMBER_PROVIDER, purpose: 'spaces', revoked_remotely: revokedRemotely },
  });
  return ok({ revokedRemotely, wasConnected: true });
}

/* -------------------------------------------------------------- items --- */

/** A member who accepted a Space and has a connection: whose mailbox is read for it. */
export interface Contributor {
  userId: string;
  integration: Integration;
}

/** A contributor's item id in a Space: who it belongs to and its id in their own mailbox. */
export const memberItemId = (userId: string, rawId: string) => `m.${userId}.${rawId}`;

const MEMBER_ITEM = /^m\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/i;

export function parseMemberItemId(id: string): { userId: string; rawId: string } | null {
  const m = MEMBER_ITEM.exec(id);
  return m ? { userId: m[1]!.toLowerCase(), rawId: m[2]! } : null;
}

export interface MemberThread {
  /** The id in the Space (memberItemId): Hide and the Space's viewer use it. */
  itemId: string;
  /** The Gmail thread id in the member's own mailbox: their Gmail link uses it. */
  threadId: string;
  subject: string;
  who: string;
  at: string;
  snippet: string;
  messages: number;
  lastFromUs: boolean;
  owner: string;
  /** The member's own address, for Gmail's authuser. */
  mailbox: string | null;
}

export interface MemberMeeting {
  itemId: string;
  title: string;
  at: string;
  upcoming: boolean;
  people: string[];
  owner: string;
  mailbox: string | null;
}

export interface MemberRead<T> {
  state: 'ok' | 'paused' | 'error';
  rows: T[];
}

interface Kept<T> {
  at: number;
  rows: T[];
}

const cache = processWide('space-member-mail', () => ({
  threads: new Map<string, Kept<MemberThread>>(),
  events: new Map<string, Kept<RawMemberEvent>>(),
}));

/** Test hook. */
export function resetMemberMailCache(): void {
  cache.threads.clear();
  cache.events.clear();
}

/** Forgets everything kept for one member: disconnecting, leaving, declining, being removed. */
export function forgetMember(userId: string): void {
  const prefix = `${userId}|`;
  for (const map of [cache.threads, cache.events] as Map<string, unknown>[]) {
    for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
  }
}

const keyFor = (c: Contributor, q: string) => `${c.userId}|${c.integration.id}|${q}`;

const ADDRESS = /[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[a-z]{2,}/gi;
const addressesIn = (header: string) => (header.match(ADDRESS) ?? []).map((a) => a.toLowerCase());

function nameOf(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (named) return named;
  const addr = addressesIn(from)[0] ?? from;
  return addr.split('@')[0] ?? addr;
}

function setKept<T>(map: Map<string, Kept<T>>, key: string, rows: T[], now: Date) {
  map.set(key, { at: now.getTime(), rows });
  if (map.size > 400) map.delete(map.keys().next().value as string);
}

function fresh<T>(hit: Kept<T> | undefined, ttl: number, now: Date): hit is Kept<T> {
  return Boolean(hit && now.getTime() - hit.at < ttl && now.getTime() >= hit.at);
}

/** One thread of a member's mailbox, as the local rule check reads it. */
interface CheckedThread {
  id: string;
  subject: string;
  messages: { from: string; to: string[]; cc: string[]; at: string; snippet: string }[];
}

function toMemberThread(t: CheckedThread, c: Contributor): MemberThread | null {
  const last = t.messages.at(-1);
  if (!last) return null;
  const own = (c.integration.account_email ?? '').toLowerCase();
  const fromOwn = (from: string) => Boolean(own) && addressesIn(from).includes(own);
  const outside = [...t.messages].reverse().find((m) => !fromOwn(m.from));
  return {
    itemId: memberItemId(c.userId, t.id),
    threadId: t.id,
    subject: t.subject.trim() || '(no subject)',
    who: outside ? nameOf(outside.from) : 'Them',
    at: last.at,
    snippet: last.snippet.slice(0, 300),
    messages: t.messages.length,
    lastFromUs: fromOwn(last.from),
    owner: c.userId,
    mailbox: c.integration.account_email,
  };
}

/** The local rule check, the same one the main mailbox's synced mail gets. */
function matches(t: CheckedThread, set: SpaceRuleSet): boolean {
  return threadMatches(
    {
      subject: t.subject,
      messages: t.messages.map((m) => ({
        from_address: addressesIn(m.from)[0] ?? '',
        to_addresses: m.to,
        cc_addresses: m.cc,
        snippet: m.snippet,
      })),
    },
    set,
  );
}

function demoChecked(thread: DemoMemberThread): CheckedThread {
  return {
    id: thread.id,
    subject: thread.subject,
    messages: thread.messages.map((m) => ({
      from: m.from,
      to: m.to.map((a) => a.toLowerCase()),
      cc: m.cc.map((a) => a.toLowerCase()),
      at: m.at,
      snippet: m.text,
    })),
  };
}

interface MetaMessage {
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (m: MetaMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** A thread's headers (From, To, Cc, Subject) and snippets: read scope, nothing changes. */
async function readChecked(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<CheckedThread | null> {
  const res = await gmailGet<{ id: string; messages?: MetaMessage[] }>(
    store,
    integration,
    `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,
  );
  if (!res.ok) return null;
  const real = (res.value.messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
  if (!real.length) return null;
  return {
    id,
    subject: header(real[0]!, 'Subject'),
    messages: real.map((m) => ({
      from: header(m, 'From'),
      to: addressesIn(header(m, 'To')),
      cc: addressesIn(header(m, 'Cc')),
      at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
      snippet: m.snippet ?? '',
    })),
  };
}

/** The demo has one fictional member mailbox, the teammate's: any other connection is empty. */
const demoMailbox = (c: Contributor, now: Date) =>
  c.integration.id === DEMO_IDS.integrationTeammateSpaces
    ? demoMemberMailbox(now)
    : { threads: [], events: [] };

const isReadable = (c: Contributor) =>
  c.integration.provider === MEMBER_PROVIDER && c.integration.status === 'connected';

/**
 * A contributor's mail for one Space: Gmail's search with the Space's rules
 * (one page, newest first), each thread checked again locally against the
 * rules. Hidden items are left out by the caller. Read-only.
 */
export async function memberThreads(
  store: DataStore,
  set: SpaceRuleSet,
  c: Contributor,
  now: Date = new Date(),
): Promise<MemberRead<MemberThread>> {
  if (c.integration.provider !== MEMBER_PROVIDER) return { state: 'error', rows: [] };
  const q = gmailQuery(set);
  if (!q) return { state: 'ok', rows: [] };
  if (isDemoMode()) {
    const rows = demoMailbox(c, now)
      .threads.map(demoChecked)
      .filter((t) => matches(t, set))
      .map((t) => toMemberThread(t, c))
      .filter((t): t is MemberThread => t !== null)
      .sort((a, b) => b.at.localeCompare(a.at));
    return { state: 'ok', rows };
  }
  if (!isReadable(c)) return { state: 'paused', rows: [] };
  const key = keyFor(c, q);
  const hit = cache.threads.get(key);
  if (fresh(hit, THREADS_TTL_MS, now)) return { state: 'ok', rows: hit.rows };
  const page = await listThreadPage(store, c.integration, { q, max: THREAD_PAGE });
  if (!page.ok) {
    log.warn('A Space contributor mailbox could not be searched', { code: page.error.code });
    return { state: page.error.code === 'provider_unauthorized' ? 'paused' : 'error', rows: [] };
  }
  const rows: MemberThread[] = [];
  const stubs = page.value.threads;
  for (let i = 0; i < stubs.length; i += FETCH_BATCH) {
    const batch = await Promise.all(
      stubs
        .slice(i, i + FETCH_BATCH)
        .map((t) => readChecked(store, c.integration, t.id).catch(() => null)),
    );
    for (const t of batch) {
      if (!t || !matches(t, set)) continue;
      const row = toMemberThread(t, c);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  setKept(cache.threads, key, rows, now);
  return { state: 'ok', rows };
}

interface RawMemberEvent {
  id: string;
  title: string;
  startsAt: string;
  attendees: { name: string | null; email: string }[];
}

interface GoogleEventLite {
  id?: string;
  status?: string;
  visibility?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; resource?: boolean }[];
}

/** The calendar search terms for a Space: its domains, addresses and keywords. */
function eventTerms(set: SpaceRuleSet): string[] {
  return [...set.domains, ...set.emails, ...set.keywords].slice(0, EVENT_TERMS_MAX);
}

/** Events on the member's own calendar mentioning one term (Calendar's own search). GET only. */
async function searchEvents(
  token: string,
  term: string,
  now: Date,
): Promise<Result<RawMemberEvent[]>> {
  const params = new URLSearchParams({
    q: term,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(EVENTS_PER_TERM),
    timeMin: new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + AHEAD_DAYS * 86_400_000).toISOString(),
  });
  try {
    const response = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      return err('provider_unauthorized', 'Google Calendar refused the request.');
    }
    if (!response.ok) {
      return err('provider_unavailable', 'Google Calendar is unavailable right now.', {
        retryable: true,
      });
    }
    const data = (await response.json()) as { items?: GoogleEventLite[] };
    return ok(
      (data.items ?? [])
        // A private or cancelled event never comes into a Space.
        .filter((e) => e.id && e.status !== 'cancelled' && e.visibility !== 'private')
        .map((e) => ({
          id: e.id!,
          title: e.summary?.trim() || '(no title)',
          startsAt: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00.000Z` : ''),
          attendees: (e.attendees ?? [])
            .filter((a) => a.email && !a.resource)
            .map((a) => ({ name: a.displayName ?? null, email: a.email!.toLowerCase() })),
        }))
        .filter((e) => e.startsAt),
    );
  } catch {
    return err('provider_unavailable', 'Could not reach Google Calendar.', { retryable: true });
  }
}

/**
 * A contributor's meetings for one Space: their own calendar searched for
 * each of the Space's terms, each event checked again locally against the
 * rules (an attendee at its domain or address, or a keyword in the title).
 * Private events never come in. Read-only.
 */
export async function memberMeetings(
  store: DataStore,
  set: SpaceRuleSet,
  c: Contributor,
  now: Date = new Date(),
): Promise<MemberRead<MemberMeeting>> {
  if (c.integration.provider !== MEMBER_PROVIDER) return { state: 'error', rows: [] };
  const terms = eventTerms(set);
  if (!terms.length) return { state: 'ok', rows: [] };
  let raw: RawMemberEvent[];
  if (isDemoMode()) {
    raw = demoMailbox(c, now).events;
  } else {
    if (!isReadable(c) || !c.integration.kinds.includes('calendar')) {
      return { state: isReadable(c) ? 'ok' : 'paused', rows: [] };
    }
    const key = keyFor(c, terms.join('\u0001'));
    const hit = cache.events.get(key);
    if (fresh(hit, EVENTS_TTL_MS, now)) {
      raw = hit.rows;
    } else {
      const token = await getAccessToken(store, c.integration);
      if (!token.ok) return { state: 'paused', rows: [] };
      const found = await Promise.all(terms.map((t) => searchEvents(token.value, t, now)));
      if (found.every((f) => !f.ok)) {
        const paused = found.some((f) => !f.ok && f.error.code === 'provider_unauthorized');
        return { state: paused ? 'paused' : 'error', rows: [] };
      }
      const byId = new Map<string, RawMemberEvent>();
      for (const f of found) if (f.ok) for (const e of f.value) byId.set(e.id, e);
      raw = [...byId.values()];
      setKept(cache.events, key, raw, now);
    }
  }
  const own = (c.integration.account_email ?? '').toLowerCase();
  const nowMs = now.getTime();
  const rows = raw
    .filter((e) => meetingMatches({ title: e.title, attendees: e.attendees }, set))
    .map((e) => ({
      itemId: memberItemId(c.userId, e.id),
      title: e.title,
      at: e.startsAt,
      upcoming: Date.parse(e.startsAt) > nowMs,
      people: e.attendees
        .filter((a) => a.email !== own)
        .map((a) => a.name?.trim() || a.email.split('@')[0] || a.email),
      owner: c.userId,
      mailbox: c.integration.account_email,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { state: 'ok', rows };
}

/** One message of a contributor's thread, as the Space's read-only viewer shows it. */
export interface MemberMessage {
  from: string;
  to: string;
  cc: string;
  at: string | null;
  text: string;
}

/**
 * One of a contributor's threads, for the Space's read-only viewer: read with
 * the read-only grant, and only when it matches the Space's rules (anything
 * else in their mailbox reads as not found). Nothing changes in Gmail, not
 * even read or unread.
 */
export async function readMemberThread(
  store: DataStore,
  set: SpaceRuleSet,
  c: Contributor,
  threadId: string,
  now: Date = new Date(),
): Promise<Result<{ subject: string; messages: MemberMessage[] }>> {
  const notFound = err('not_found', 'That email is not in this Space.');
  if (c.integration.provider !== MEMBER_PROVIDER) return notFound;
  if (!/^[0-9a-f]{10,24}$/i.test(threadId)) return notFound;
  if (isDemoMode()) {
    const t = demoMailbox(c, now).threads.find((x) => x.id === threadId);
    if (!t || !matches(demoChecked(t), set)) return notFound;
    return ok({
      subject: t.subject,
      messages: t.messages.map((m) => ({
        from: m.from,
        to: m.to.join(', '),
        cc: m.cc.join(', '),
        at: m.at,
        text: m.text,
      })),
    });
  }
  if (!isReadable(c)) {
    return err(
      'provider_unauthorized',
      'Their Google connection is paused. They can reconnect it.',
    );
  }
  const full = await readThreadFull(store, c.integration, threadId);
  if (!full.ok) return full.error.code === 'provider_unauthorized' ? full : notFound;
  const checked: CheckedThread = {
    id: threadId,
    subject: full.value.subject,
    messages: full.value.messages.map((m) => ({
      from: m.from,
      to: addressesIn(m.to),
      cc: addressesIn(m.cc),
      at: m.date ?? '',
      snippet: m.text.slice(0, 400),
    })),
  };
  if (!matches(checked, set)) return notFound;
  return ok({
    subject: full.value.subject,
    messages: full.value.messages.map((m) => ({
      from: m.from,
      to: m.to,
      cc: m.cc,
      at: m.date,
      text: m.text,
    })),
  });
}
