import { classifyMeeting, meetingFromStoredEvent } from '@/lib/calendar/meetings';
import { addressOf, isAutomatedAddress } from '@/lib/services/network';
import {
  isBulkAddress,
  isPersonalDomain,
  MAX_GROUP,
  registrableDomain,
  type ParsedThread,
  type Participant,
} from '@/lib/services/warm-paths';
import type { CalendarEvent, EmailMessage, EmailThread } from '@/lib/types/domain';
import type { RelationshipEvidence } from '@/lib/network/strength';

/**
 * The relationship index: Nick's synced mail and calendar, arranged so the
 * evidence for any person — or everyone at a company — is a lookup rather
 * than another scan. Built once per organization and cached by the service
 * (services/relationships.ts); everything here is a pure function of rows
 * the store already holds, so it is tested without one.
 *
 * Counting follows the Network list (services/network.ts) exactly: a message
 * someone sent us counts for its sender, a message we sent counts for each of
 * its recipients. So the figures on a profile and on Network always agree.
 * Refinements for strength, all about not mistaking something else for a
 * relationship: a message or meeting with more than MAX_GROUP outside people
 * is a broadcast and earns nobody anything; an invitation someone declined is
 * not a meeting with them; and a calendar entry only counts as a meeting at
 * all when the meeting-alert classifier (lib/calendar/meetings.ts) says it is
 * one and Nick has not declined or left it unanswered — so a hold, a block, an
 * invite he turned down and a booked room are never a meeting with anyone.
 */

export interface IndexMessage {
  at: number;
  from: string | null;
  fromUs: boolean;
  /** Everyone on To and Cc, lower case, our own addresses included. */
  recipients: string[];
  /** Too many people on it to say anything about any one of them. */
  mass: boolean;
}

export interface IndexThread {
  key: string;
  /** Gmail's thread id, for a link; null when the thread row was not in the scan. */
  gmailId: string | null;
  subject: string | null;
  /** Oldest first. */
  messages: IndexMessage[];
  /** Best name seen per address on the thread. */
  names: Map<string, string>;
}

export interface IndexMeeting {
  id: string;
  title: string;
  at: number;
  /** Outside attendees who did not decline, lower case. */
  attendees: string[];
}

interface AddressEntry {
  threads: Set<string>;
  meetings: Set<number>;
  names: Map<string, number>;
}

export interface RelationshipIndex {
  own: ReadonlySet<string>;
  threads: Map<string, IndexThread>;
  meetings: IndexMeeting[];
  byAddress: Map<string, AddressEntry>;
  /** Registrable domain → the addresses at it with any evidence. Personal mail is left out. */
  byDomain: Map<string, Set<string>>;
  /** What was scanned, so a page can say how far back "first email" can see. */
  scanned: { messages: number; events: number; oldestMessageAt: string | null };
  builtAt: number;
}

export interface IndexInput {
  messages: readonly EmailMessage[];
  events: readonly CalendarEvent[];
  threads: readonly EmailThread[];
  ownAddresses: readonly string[];
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1);

const ROOM = /(^|\.)resource\.calendar\.google\.com$/;

/**
 * Whether a synced calendar entry is a meeting Nick is going to (or went to):
 * the classifier the meeting alerts use — which already rules out his own
 * declines, unconfirmed holds, blocks, personal time and invites everyone
 * else declined — plus one rule of its own: an invitation he never answered
 * is not a meeting he had. A booked room is never one of the people on it.
 */
function isMeetingWeHad(event: CalendarEvent, own: ReadonlySet<string>): boolean {
  if (!classifyMeeting(meetingFromStoredEvent(event), [...own]).meeting) return false;
  const mine = event.attendees.find((a) => {
    const address = addressOf(a.email);
    return address !== null && own.has(address);
  });
  return mine?.response !== 'needsAction' && mine?.response !== 'declined';
}

/** An attendee who is a person on the other side: not us, not a room, not a robot, not declined. */
function isOutsideGuest(
  attendee: CalendarEvent['attendees'][number],
  own: ReadonlySet<string>,
): boolean {
  const address = addressOf(attendee.email);
  if (address === null || own.has(address) || attendee.response === 'declined') return false;
  return !ROOM.test(domainOf(address)) && !isAutomatedAddress(address);
}

function entryFor(index: RelationshipIndex, email: string): AddressEntry {
  let entry = index.byAddress.get(email);
  if (!entry) {
    entry = { threads: new Set(), meetings: new Set(), names: new Map() };
    index.byAddress.set(email, entry);
    const host = domainOf(email);
    if (!isPersonalDomain(host)) {
      const domain = registrableDomain(host);
      const at = index.byDomain.get(domain) ?? new Set<string>();
      at.add(email);
      index.byDomain.set(domain, at);
    }
  }
  return entry;
}

function noteName(entry: AddressEntry, name: string | null | undefined) {
  const clean = name?.trim();
  if (!clean || clean.includes('@')) return;
  entry.names.set(clean, (entry.names.get(clean) ?? 0) + 1);
}

/** The index for these rows. `now` only stamps it; past and future are decided per question. */
export function buildRelationshipIndex(
  input: IndexInput,
  now: Date = new Date(),
): RelationshipIndex {
  const own = new Set(
    input.ownAddresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@')),
  );
  const index: RelationshipIndex = {
    own,
    threads: new Map(),
    meetings: [],
    byAddress: new Map(),
    byDomain: new Map(),
    scanned: {
      messages: input.messages.length,
      events: input.events.length,
      oldestMessageAt: null,
    },
    builtAt: now.getTime(),
  };
  const threadRows = new Map(input.threads.map((t) => [t.id, t]));

  let oldest: number | null = null;
  for (const message of input.messages) {
    const at = Date.parse(message.sent_at);
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;

    const from = addressOf(message.from_address);
    const fromUs = from !== null && own.has(from);
    const recipients = [
      ...new Set(
        [...message.to_addresses, ...message.cc_addresses]
          .map(addressOf)
          .filter((a): a is string => a !== null),
      ),
    ];
    const outside = new Set([from, ...recipients].filter((a): a is string => !!a && !own.has(a)));
    const mass = outside.size > MAX_GROUP;

    let thread = index.threads.get(message.thread_id);
    if (!thread) {
      const row = threadRows.get(message.thread_id);
      thread = {
        key: message.thread_id,
        gmailId: row?.provider_thread_id ?? null,
        subject: row?.subject ?? message.subject,
        messages: [],
        names: new Map(),
      };
      index.threads.set(message.thread_id, thread);
    }
    thread.messages.push({ at, from, fromUs, recipients, mass });
    if (from && message.from_name?.trim() && !thread.names.has(from)) {
      thread.names.set(from, message.from_name.trim());
    }

    if (mass) continue;
    if (fromUs) {
      for (const r of recipients) if (!own.has(r)) entryFor(index, r).threads.add(thread.key);
    } else if (from) {
      const entry = entryFor(index, from);
      entry.threads.add(thread.key);
      noteName(entry, message.from_name);
    }
  }
  for (const thread of index.threads.values()) thread.messages.sort((a, b) => a.at - b.at);
  index.scanned.oldestMessageAt = oldest === null ? null : new Date(oldest).toISOString();

  for (const event of input.events) {
    // Private events keep their attendees to themselves, as on Network.
    if (event.is_private) continue;
    const at = Date.parse(event.starts_at);
    if (Number.isNaN(at)) continue;
    if (!isMeetingWeHad(event, own)) continue;
    const attendees = event.attendees.filter((a) => isOutsideGuest(a, own));
    if (attendees.length === 0 || attendees.length > MAX_GROUP) continue;
    const position = index.meetings.length;
    index.meetings.push({
      id: event.id,
      title: event.title,
      at,
      attendees: attendees.map((a) => addressOf(a.email) as string),
    });
    for (const a of attendees) {
      const entry = entryFor(index, addressOf(a.email) as string);
      entry.meetings.add(position);
      noteName(entry, a.name);
    }
  }

  return index;
}

/** The name most often seen for an address, or null. */
export function nameFor(index: RelationshipIndex, email: string): string | null {
  const names = index.byAddress.get(email)?.names;
  if (!names) return null;
  let best: string | null = null;
  let count = 0;
  for (const [name, n] of names) {
    if (n > count) {
      best = name;
      count = n;
    }
  }
  return best;
}

/** Someone worth listing as a person: not us, not a machine, not a role inbox. */
export function isPerson(index: RelationshipIndex, email: string): boolean {
  return !index.own.has(email) && !isAutomatedAddress(email) && !isBulkAddress(email);
}

/**
 * Every person at a company's domain the mail or calendar has seen, matched on
 * the registrable domain (mail.example.com is example.com). A personal-mail
 * domain matches nobody: a company is never "everyone on gmail.com".
 */
export function addressesAtDomain(index: RelationshipIndex, domain: string | null): string[] {
  if (!domain) return [];
  const host = domain.trim().toLowerCase();
  if (!host || isPersonalDomain(host)) return [];
  const found = index.byDomain.get(registrableDomain(host));
  return found ? [...found].filter((e) => isPerson(index, e)).sort() : [];
}

/* --------------------------------------------------------------- evidence */

export interface ThreadTouch {
  key: string;
  gmailId: string | null;
  subject: string | null;
  firstAt: number;
  lastAt: number;
  emailsIn: number;
  emailsOut: number;
  weStarted: boolean;
  /** Whether the newest counted message on it was from Nick's side. */
  lastFromUs: boolean;
}

export interface MeetingTouch {
  id: string;
  title: string;
  at: number;
  upcoming: boolean;
}

export interface EvidenceDetail {
  evidence: RelationshipEvidence;
  /** Newest first. */
  threads: ThreadTouch[];
  /** Newest first, upcoming ones included. */
  meetings: MeetingTouch[];
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/**
 * The evidence for a set of addresses — one person's, or everyone's at a
 * company, counted once per thread and once per meeting however many of them
 * were on it. Anything after `now` is a booking, not contact.
 */
export function evidenceFor(
  index: RelationshipIndex,
  addresses: Iterable<string>,
  now: Date = new Date(),
): EvidenceDetail {
  const who = new Set([...addresses].map((a) => a.trim().toLowerCase()));
  const nowMs = now.getTime();
  const threadKeys = new Set<string>();
  const meetingIds = new Set<number>();
  for (const address of who) {
    const entry = index.byAddress.get(address);
    if (!entry) continue;
    for (const k of entry.threads) threadKeys.add(k);
    for (const m of entry.meetings) meetingIds.add(m);
  }

  const threads: ThreadTouch[] = [];
  let twoWay = 0;
  let outOnly = 0;
  let inOnly = 0;
  let weStarted = 0;
  let theyStarted = 0;
  let emailsIn = 0;
  let emailsOut = 0;
  let firstEmail: number | null = null;
  let lastEmail: number | null = null;

  for (const key of threadKeys) {
    const thread = index.threads.get(key);
    if (!thread) continue;
    let touch: ThreadTouch | null = null;
    for (const m of thread.messages) {
      if (m.mass || m.at > nowMs) continue;
      const involves = m.fromUs
        ? m.recipients.some((r) => who.has(r))
        : m.from !== null && who.has(m.from);
      if (!involves) continue;
      touch ??= {
        key,
        gmailId: thread.gmailId,
        subject: thread.subject,
        firstAt: m.at,
        lastAt: m.at,
        emailsIn: 0,
        emailsOut: 0,
        weStarted: m.fromUs,
        lastFromUs: m.fromUs,
      };
      touch.lastAt = m.at;
      touch.lastFromUs = m.fromUs;
      if (m.fromUs) touch.emailsOut += 1;
      else touch.emailsIn += 1;
    }
    if (!touch) continue;
    threads.push(touch);
    emailsIn += touch.emailsIn;
    emailsOut += touch.emailsOut;
    if (touch.emailsIn > 0 && touch.emailsOut > 0) twoWay += 1;
    else if (touch.emailsOut > 0) outOnly += 1;
    else inOnly += 1;
    if (touch.weStarted) weStarted += 1;
    else theyStarted += 1;
    if (firstEmail === null || touch.firstAt < firstEmail) firstEmail = touch.firstAt;
    if (lastEmail === null || touch.lastAt > lastEmail) lastEmail = touch.lastAt;
  }

  const meetings: MeetingTouch[] = [];
  let held = 0;
  let lastMeeting: number | null = null;
  let nextMeeting: number | null = null;
  for (const i of meetingIds) {
    const m = index.meetings[i];
    if (!m) continue;
    const upcoming = m.at > nowMs;
    meetings.push({ id: m.id, title: m.title, at: m.at, upcoming });
    if (upcoming) {
      if (nextMeeting === null || m.at < nextMeeting) nextMeeting = m.at;
    } else {
      held += 1;
      if (lastMeeting === null || m.at > lastMeeting) lastMeeting = m.at;
    }
  }

  threads.sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));
  meetings.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const lastContact =
    lastEmail === null
      ? lastMeeting
      : lastMeeting === null
        ? lastEmail
        : Math.max(lastEmail, lastMeeting);

  return {
    evidence: {
      threads: threads.length,
      twoWayThreads: twoWay,
      outboundOnlyThreads: outOnly,
      inboundOnlyThreads: inOnly,
      weStarted,
      theyStarted,
      emailsIn,
      emailsOut,
      meetingsHeld: held,
      firstEmailAt: iso(firstEmail),
      lastEmailAt: iso(lastEmail),
      lastMeetingAt: iso(lastMeeting),
      nextMeetingAt: iso(nextMeeting),
      lastContactAt: iso(lastContact),
    },
    threads,
    meetings,
  };
}

/* ------------------------------------------------------------ warm paths */

/**
 * Synced threads in the shape warm-paths reads (ParsedThread), so "who can
 * intro" runs the very rules Fund II's Gmail lookup uses — per message, mass
 * mail left out — over mail Copilot already holds, with no Gmail call. Only
 * threads touching one of `addresses` or `domains` are converted.
 */
export function warmThreadsFor(
  index: RelationshipIndex,
  match: { addresses?: readonly string[]; domains?: readonly string[] },
  now: Date = new Date(),
): ParsedThread[] {
  const addresses = new Set((match.addresses ?? []).map((a) => a.toLowerCase()));
  const domains = (match.domains ?? []).map((d) => registrableDomain(d.toLowerCase()));
  const hits = (email: string) => {
    if (addresses.has(email)) return true;
    const host = domainOf(email);
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  };
  const nowMs = now.getTime();
  const out: ParsedThread[] = [];
  for (const thread of index.threads.values()) {
    const messages = thread.messages.filter((m) => m.at <= nowMs);
    if (!messages.some((m) => (m.from && hits(m.from)) || m.recipients.some(hits))) continue;
    const people = new Map<string, Participant>();
    for (const m of messages) {
      for (const email of [m.from, ...m.recipients]) {
        if (!email || people.has(email)) continue;
        people.set(email, { email, name: thread.names.get(email) ?? nameFor(index, email) });
      }
    }
    out.push({
      id: thread.gmailId ?? thread.key,
      subject: thread.subject ?? '',
      lastAt: iso(messages[messages.length - 1]?.at ?? null),
      participants: [...people.values()],
      messages: messages.map((m) => ({ from: m.from ? [m.from] : [], recipients: m.recipients })),
    });
  }
  return out;
}
