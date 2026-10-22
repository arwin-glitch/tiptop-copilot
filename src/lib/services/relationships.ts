import 'server-only';
import { NICK_ALIASES } from '@/lib/calendar/meetings';
import { listOrganizationMembers } from '@/lib/db/members';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { gmailThreadUrl } from '@/lib/deals/links';
import {
  addressesAtDomain,
  buildRelationshipIndex,
  evidenceFor,
  isPerson,
  nameFor,
  warmThreadsFor,
  type EvidenceDetail,
  type RelationshipIndex,
} from '@/lib/network/evidence';
import {
  affinitySmartValues,
  DEFAULT_GOING_COLD_DAYS,
  evidenceSummary,
  isGoingCold,
  peakLabel,
  scoreRelationship,
  smartFields,
  STRENGTH_LABELS,
  type RecordRelationshipRow,
  type RelationshipEvidence,
  type RelationshipStrength,
  type SmartFields,
  type StrengthBadgeData,
  type StrengthLabel,
} from '@/lib/network/strength';
import type { CrmList, CrmListEntry, CrmRecord, CrmValue, Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { corporateEmailDomain } from '@/lib/util/text';
import type { RelationshipItem, Relationships } from './follow-ups';
import { loadCorrespondence } from './network';
import {
  buildWarmPaths,
  isPersonalDomain,
  registrableDomain,
  warmContext,
  type WarmTarget,
} from './warm-paths';

/**
 * Relationship intelligence for CRM records and the Network page: how strong
 * each relationship is, why, when the last and next contact were, and who can
 * make an introduction — all from the mail and calendar Copilot already syncs.
 *
 * One index per organization (network/evidence.ts), built from the same rows
 * Network counts and kept for five minutes, so a list page asking about a
 * hundred rows costs one scan at most and then lookups — never a Gmail call
 * per row. Scores come from network/strength.ts, where every weight is listed.
 *
 * "Us" is the whole fund: every member's address, every connected mailbox
 * and Nick's aliases (fundAddresses), never just whoever is looking. So a
 * record scores the same for Nick and for Arwin, and a colleague is never a
 * "person" in Nick's network.
 *
 * Reads only. A store that cannot be read is an error the page shows, never
 * an empty answer that would read as "no relationship"; a table that does not
 * exist yet reads as no mail at all.
 */

const TTL_MS = 5 * 60_000;
const MESSAGE_LIMIT = 2000;
const TIMELINE_MAX = 8;
const PEOPLE_MAX = 10;
const INTRODUCERS_MAX = 5;
/** Ids the list columns ask about in one request: one page of a list. */
export const RELATIONSHIP_BATCH_MAX = 100;

export interface RelationshipScope {
  /**
   * The signed-in user's and the connected mailbox's addresses, for the
   * Network list. The index itself does not read them: it counts every
   * address of the fund as "us" (fundAddresses), whoever is looking.
   */
  ownAddresses: readonly string[];
  /** The connected mailbox, for Gmail links in its own account. */
  accountEmail?: string | null;
  now?: Date;
}

/** The scope for a signed-in user: their address and the mailbox's. */
export function relationshipScope(
  profileEmail: string | null | undefined,
  integration: Pick<Integration, 'account_email'> | null | undefined,
  now?: Date,
): RelationshipScope {
  return {
    ownAddresses: [profileEmail, integration?.account_email].filter((a): a is string => !!a),
    accountEmail: integration?.account_email ?? null,
    now,
  };
}

/* ------------------------------------------------------------------ cache */

const cache = processWide('relationship-index', () => ({
  built: new Map<string, { at: number; index: RelationshipIndex }>(),
  pending: new Map<string, Promise<RelationshipIndex>>(),
}));

/** Test hook, and what a sync could call to show fresh mail at once. */
export function resetRelationshipCache(): void {
  cache.built.clear();
  cache.pending.clear();
}

const normalise = (a: string) => a.trim().toLowerCase();

/**
 * Every address the fund itself sends from: each member's sign-in address,
 * each connected mailbox, and Nick's aliases. Throws when the members or
 * mailboxes cannot be read (counting without them would score a colleague
 * as a relationship), so each caller decides what a failure means.
 */
export async function fundAddresses(store: DataStore, organizationId: string): Promise<string[]> {
  const read = async <T>(rows: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await rows();
    } catch (error) {
      if (isMissingTableError(error)) return [];
      throw error;
    }
  };
  const [members, integrations] = await Promise.all([
    read(() => listOrganizationMembers(store, organizationId)),
    read(() => store.list('integrations', organizationId, {}) as Promise<Integration[]>),
  ]);
  const profiles = await Promise.all(members.map((m) => store.userProfileById(m.user_id)));
  return [
    ...new Set(
      [
        ...profiles.map((p) => p?.email ?? null),
        ...integrations.map((i) => i.account_email),
        ...NICK_ALIASES,
      ]
        .filter((a): a is string => typeof a === 'string')
        .map(normalise)
        .filter((a) => a.includes('@')),
    ),
  ].sort();
}

async function loadIndex(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<RelationshipIndex> {
  const own = await fundAddresses(store, organizationId);
  try {
    const { messages, events, threads } = await loadCorrespondence(store, organizationId, {
      limit: MESSAGE_LIMIT,
      now,
      threads: true,
    });
    return buildRelationshipIndex({ messages, events, threads, ownAddresses: own }, now);
  } catch (error) {
    if (isMissingTableError(error)) {
      return buildRelationshipIndex(
        { messages: [], events: [], threads: [], ownAddresses: own },
        now,
      );
    }
    throw error;
  }
}

/**
 * The organization's relationship index, from cache when under five minutes
 * old. One per organization, the same for every viewer. Concurrent callers
 * share one build.
 */
export async function getRelationshipIndex(
  store: DataStore,
  organizationId: string,
  scope: RelationshipScope,
  options: { force?: boolean } = {},
): Promise<Result<RelationshipIndex>> {
  const now = scope.now ?? new Date();
  const key = organizationId;
  const hit = cache.built.get(key);
  const age = hit ? now.getTime() - hit.at : Infinity;
  if (!options.force && hit && age >= 0 && age < TTL_MS) return ok(hit.index);

  let pending = cache.pending.get(key);
  if (!pending) {
    pending = loadIndex(store, organizationId, now).finally(() => cache.pending.delete(key));
    cache.pending.set(key, pending);
  }
  try {
    const index = await pending;
    cache.built.set(key, { at: now.getTime(), index });
    if (cache.built.size > 50) cache.built.delete(cache.built.keys().next().value as string);
    return ok(index);
  } catch {
    return err('provider_unavailable', "Mail and calendar couldn't be read just now.", {
      retryable: true,
      stillUsable: 'The rest of the profile and the lists.',
    });
  }
}

/* -------------------------------------------------------------- records */

type RecordLike = Pick<CrmRecord, 'id' | 'kind' | 'name' | 'domain' | 'emails'> & {
  fields?: Record<string, CrmValue>;
  primary_email?: string | null;
};

type MembershipLike = {
  entry: Pick<CrmListEntry, 'values'>;
  list: Pick<CrmList, 'fields'>;
};

/** The addresses whose mail and meetings count for a record, and how they were found. */
export function recordAddresses(
  index: RelationshipIndex,
  record: RecordLike,
  related: readonly { primary_email: string | null }[] = [],
): { by: 'emails' | 'domain' | 'none'; addresses: string[] } {
  const emails = record.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
  if (record.kind === 'person') {
    return { by: emails.length ? 'emails' : 'none', addresses: [...new Set(emails)] };
  }
  const atDomain = addressesAtDomain(index, record.domain);
  const people = related
    .map((r) => r.primary_email?.trim().toLowerCase())
    .filter((e): e is string => !!e && e.includes('@'));
  const addresses = [...new Set([...atDomain, ...people, ...emails])].filter((e) =>
    isPerson(index, e),
  );
  if (!addresses.length) return { by: 'none', addresses: [] };
  return { by: atDomain.length ? 'domain' : 'emails', addresses };
}

export interface RelatedPerson {
  email: string;
  name: string | null;
  /** Their CRM profile, when one is known on this page. */
  recordId: string | null;
  strength: RelationshipStrength;
  summary: string;
  lastContactAt: string | null;
}

export interface TimelineItem {
  kind: 'thread' | 'meeting';
  key: string;
  at: string;
  title: string;
  /** Gmail for a thread; null for a meeting or a thread without a Gmail id. */
  href: string | null;
  detail: string;
  upcoming: boolean;
}

export interface Introducer {
  email: string;
  name: string | null;
  /** Small threads they share with the record's people. */
  threads: number;
  lastAt: string | null;
  subject: string;
  href: string | null;
}

export interface RecordRelationship {
  /**
   * How the record was matched to mail. `matchable` is false when there was
   * nothing to match on at all (a person with no email, a company with no
   * domain or people), so no evidence there means "unknown", not "none".
   */
  matched: { by: 'emails' | 'domain' | 'none'; addresses: number; matchable: boolean };
  evidence: RelationshipEvidence;
  strength: RelationshipStrength;
  /** "12 threads, last Oct 3; 2 meetings". */
  summary: string;
  smart: SmartFields;
  goingCold: boolean;
  timeline: TimelineItem[];
  /** For a company, its people; for a person, colleagues at their company. Strongest first. */
  people: RelatedPerson[];
  introducers: Introducer[];
  /** Who the intro paths were worked out for. */
  introTarget: WarmTarget | null;
  /** How much mail was scanned, so "first email" can say how far back it can see. */
  scanned: { messages: number; oldestMessageAt: string | null };
}

function timelineOf(
  detail: EvidenceDetail,
  accountEmail: string | null | undefined,
): TimelineItem[] {
  const threads: TimelineItem[] = detail.threads.map((t) => ({
    kind: 'thread',
    key: t.key,
    at: new Date(t.lastAt).toISOString(),
    title: t.subject?.trim() || '(no subject)',
    href: t.gmailId ? gmailThreadUrl(t.gmailId, accountEmail) : null,
    detail: [
      t.emailsIn ? `${t.emailsIn} from them` : null,
      t.emailsOut ? `${t.emailsOut} from Nick` : null,
      t.weStarted ? 'Nick wrote first' : 'they wrote first',
    ]
      .filter(Boolean)
      .join(' · '),
    upcoming: false,
  }));
  const meetings: TimelineItem[] = detail.meetings.map((m) => ({
    kind: 'meeting',
    key: m.id,
    at: new Date(m.at).toISOString(),
    title: m.title,
    href: null,
    detail: m.upcoming ? 'Booked' : 'Meeting held',
    upcoming: m.upcoming,
  }));
  const upcoming = meetings.filter((m) => m.upcoming).sort((a, b) => a.at.localeCompare(b.at));
  const past = [...threads, ...meetings.filter((m) => !m.upcoming)].sort(
    (a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key),
  );
  return [...upcoming.slice(0, 1), ...past].slice(0, TIMELINE_MAX);
}

function peopleOf(
  index: RelationshipIndex,
  addresses: readonly string[],
  now: Date,
  timeZone: string,
  recordIds: ReadonlyMap<string, string>,
  max: number,
): RelatedPerson[] {
  return addresses
    .map((email) => {
      const { evidence } = evidenceFor(index, [email], now);
      const strength = scoreRelationship(evidence, now);
      return {
        email,
        name: nameFor(index, email),
        recordId: recordIds.get(email) ?? null,
        strength,
        summary: evidenceSummary(evidence, now, timeZone),
        lastContactAt: evidence.lastContactAt,
      };
    })
    .filter((p) => p.strength.label !== 'none')
    .sort(
      (a, b) =>
        b.strength.score - a.strength.score ||
        (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? '') ||
        a.email.localeCompare(b.email),
    )
    .slice(0, max);
}

/** Who to work intro paths out for: a company's domain, or a person's own addresses. */
function introTargetFor(record: RecordLike, addresses: readonly string[]): WarmTarget | null {
  if (record.kind === 'company') {
    const host = record.domain?.trim().toLowerCase();
    if (host && !isPersonalDomain(host)) {
      return {
        kind: 'domain',
        label: record.name,
        domains: [registrableDomain(host)],
        addresses: [],
      };
    }
    return addresses.length
      ? { kind: 'person', label: record.name, domains: [], addresses: [...addresses] }
      : null;
  }
  return addresses.length
    ? { kind: 'person', label: record.name, domains: [], addresses: [...addresses] }
    : null;
}

/**
 * Everything the profile's Relationship and "Who can intro" panels show for
 * one CRM record. The intro paths run warm-paths' own rules over synced mail;
 * the 3-year Gmail lookup stays a click away on the panel.
 */
export async function getRecordRelationship(
  store: DataStore,
  organizationId: string,
  input: {
    record: RecordLike;
    memberships?: readonly MembershipLike[];
    related?: readonly { id: string; primary_email: string | null }[];
    timeZone?: string;
  },
  scope: RelationshipScope,
): Promise<Result<RecordRelationship>> {
  const now = scope.now ?? new Date();
  const timeZone = input.timeZone ?? 'UTC';
  const loaded = await getRelationshipIndex(store, organizationId, scope);
  if (!loaded.ok) return loaded;
  const index = loaded.value;
  const { record } = input;
  const related = input.related ?? [];

  const matched = recordAddresses(index, record, related);
  const detail = evidenceFor(index, matched.addresses, now);
  const strength = scoreRelationship(detail.evidence, now);
  const affinity = affinitySmartValues(
    (input.memberships ?? []).map((m) => ({ fields: m.list.fields, values: m.entry.values })),
    record.fields ?? {},
  );

  const recordIds = new Map<string, string>();
  for (const r of related) {
    const email = r.primary_email?.trim().toLowerCase();
    if (email) recordIds.set(email, r.id);
  }
  let peopleAddresses: string[] = [];
  if (record.kind === 'company') {
    peopleAddresses = matched.addresses;
  } else {
    const own = new Set(matched.addresses);
    const domains = [
      ...new Set(
        matched.addresses.map((e) => corporateEmailDomain(e)).filter((d): d is string => !!d),
      ),
    ];
    peopleAddresses = [...new Set(domains.flatMap((d) => addressesAtDomain(index, d)))].filter(
      (e) => !own.has(e),
    );
  }
  const people = peopleOf(
    index,
    peopleAddresses,
    now,
    timeZone,
    recordIds,
    record.kind === 'company' ? PEOPLE_MAX : 6,
  );

  const target = introTargetFor(record, matched.addresses);
  let introducers: Introducer[] = [];
  if (target) {
    const base = warmContext(scope.accountEmail);
    const ctx = {
      ownAddresses: [...new Set([...base.ownAddresses, ...index.own])],
      ownDomains: base.ownDomains,
    };
    const threads = warmThreadsFor(
      index,
      { addresses: target.addresses, domains: target.domains },
      now,
    );
    introducers = buildWarmPaths(threads, target, ctx)
      .introducers.slice(0, INTRODUCERS_MAX)
      .map((t) => ({
        email: t.email,
        name: t.name ?? nameFor(index, t.email),
        threads: t.threads,
        lastAt: t.lastAt,
        subject: t.subject,
        href: gmailThreadUrl(t.threadId, scope.accountEmail),
      }));
  }

  const matchable =
    record.kind === 'person'
      ? matched.by !== 'none'
      : Boolean(record.domain?.trim()) ||
        record.emails.length > 0 ||
        related.some((r) => !!r.primary_email);
  return ok({
    matched: { by: matched.by, addresses: matched.addresses.length, matchable },
    evidence: detail.evidence,
    strength,
    summary: evidenceSummary(detail.evidence, now, timeZone),
    smart: smartFields(detail.evidence, affinity, {
      scannedFrom: index.scanned.oldestMessageAt,
    }),
    goingCold: isGoingCold(strength, detail.evidence),
    timeline: timelineOf(detail, scope.accountEmail),
    people,
    introducers,
    introTarget: target,
    scanned: { messages: index.scanned.messages, oldestMessageAt: index.scanned.oldestMessageAt },
  });
}

/* ----------------------------------------------------------- list columns */

/**
 * Strength and smart fields for a page of CRM records, in one pass over the
 * cached index: the optional relationship columns on a list. Unknown ids are
 * left out; a store without the CRM tables answers with nothing.
 */
export async function relationshipRowsForRecords(
  store: DataStore,
  organizationId: string,
  recordIds: readonly string[],
  scope: RelationshipScope & { timeZone?: string },
): Promise<Result<Record<string, RecordRelationshipRow>>> {
  const ids = [...new Set(recordIds)].slice(0, RELATIONSHIP_BATCH_MAX);
  if (!ids.length) return ok({});
  const now = scope.now ?? new Date();

  let records: CrmRecord[];
  let entries: CrmListEntry[];
  let lists: CrmList[];
  try {
    [records, entries] = await Promise.all([
      store.list('crm_records', organizationId, { in: { id: ids } }) as Promise<CrmRecord[]>,
      store.list('crm_list_entries', organizationId, { in: { record_id: ids } }) as Promise<
        CrmListEntry[]
      >,
    ]);
    const listIds = [...new Set(entries.map((e) => e.list_id))];
    lists = listIds.length
      ? ((await store.list('crm_lists', organizationId, { in: { id: listIds } })) as CrmList[])
      : [];
  } catch (error) {
    if (isMissingTableError(error)) return ok({});
    return err('provider_unavailable', "The lists couldn't be read just now.", { retryable: true });
  }

  const loaded = await getRelationshipIndex(store, organizationId, scope);
  if (!loaded.ok) return loaded;
  const index = loaded.value;
  const listById = new Map(lists.map((l) => [l.id, l]));
  const entriesByRecord = new Map<string, CrmListEntry[]>();
  for (const e of entries) {
    if (!e.record_id) continue;
    const list = entriesByRecord.get(e.record_id) ?? [];
    list.push(e);
    entriesByRecord.set(e.record_id, list);
  }

  const out: Record<string, RecordRelationshipRow> = {};
  for (const record of records) {
    const { addresses } = recordAddresses(index, record);
    const { evidence } = evidenceFor(index, addresses, now);
    const strength = scoreRelationship(evidence, now);
    const affinity = affinitySmartValues(
      (entriesByRecord.get(record.id) ?? []).flatMap((e) => {
        const list = listById.get(e.list_id);
        return list ? [{ fields: list.fields, values: e.values }] : [];
      }),
      record.fields,
    );
    out[record.id] = {
      score: strength.score,
      label: strength.label,
      summary: evidenceSummary(evidence, now, scope.timeZone ?? 'UTC'),
      smart: smartFields(evidence, affinity, { scannedFrom: index.scanned.oldestMessageAt }),
    };
  }
  return ok(out);
}

/* ---------------------------------------------------------------- network */

/** A strength badge for each address, for the Network list. Addresses with no evidence are left out. */
export async function networkStrengths(
  store: DataStore,
  organizationId: string,
  emails: readonly string[],
  scope: RelationshipScope & { timeZone?: string },
): Promise<Result<Record<string, StrengthBadgeData>>> {
  const loaded = await getRelationshipIndex(store, organizationId, scope);
  if (!loaded.ok) return loaded;
  const now = scope.now ?? new Date();
  const out: Record<string, StrengthBadgeData> = {};
  for (const email of emails) {
    const { evidence } = evidenceFor(loaded.value, [email], now);
    const strength = scoreRelationship(evidence, now);
    if (strength.label === 'none') continue;
    out[email] = {
      score: strength.score,
      label: strength.label,
      summary: evidenceSummary(evidence, now, scope.timeZone ?? 'UTC'),
    };
  }
  return ok(out);
}

export interface GoingColdPerson {
  email: string;
  name: string | null;
  strength: RelationshipStrength;
  /** What the relationship was worth before the silence (see peakLabel). */
  peak: StrengthLabel;
  summary: string;
  lastContactAt: string;
  days: number;
  /** The newest thread with them that has a Gmail id, for a link. */
  threadId: string | null;
}

/**
 * Relationships that were Strong or Warm before the silence, with no email or
 * meeting for `days` or more and nothing booked, strongest history first. The
 * longest-quiet stay on the list rather than dropping off it: they are the
 * ones most in need of a note (see isGoingCold).
 */
export async function goingCold(
  store: DataStore,
  organizationId: string,
  scope: RelationshipScope & { timeZone?: string },
  days: number = DEFAULT_GOING_COLD_DAYS,
  max = 40,
): Promise<Result<GoingColdPerson[]>> {
  const loaded = await getRelationshipIndex(store, organizationId, scope);
  if (!loaded.ok) return loaded;
  const index = loaded.value;
  const now = scope.now ?? new Date();
  const out: GoingColdPerson[] = [];
  for (const email of index.byAddress.keys()) {
    if (!isPerson(index, email)) continue;
    const detail = evidenceFor(index, [email], now);
    const strength = scoreRelationship(detail.evidence, now);
    if (!isGoingCold(strength, detail.evidence, days) || !detail.evidence.lastContactAt) continue;
    out.push({
      email,
      name: nameFor(index, email),
      strength,
      peak: peakLabel(strength),
      summary: evidenceSummary(detail.evidence, now, scope.timeZone ?? 'UTC'),
      lastContactAt: detail.evidence.lastContactAt,
      days: strength.daysSinceContact ?? days,
      threadId:
        detail.threads.find((t) => t.gmailId && /^[0-9a-f]{10,24}$/i.test(t.gmailId))?.gmailId ??
        null,
    });
  }
  return ok(
    out
      .sort(
        (a, b) =>
          b.strength.base - a.strength.base ||
          b.strength.score - a.strength.score ||
          b.days - a.days,
      )
      .slice(0, max),
  );
}

/** "Strong (69)", or for one that has already faded, "Cold (25), was Strong". */
function coldNote(person: Pick<GoingColdPerson, 'strength' | 'peak'>): string {
  const current = `${STRENGTH_LABELS[person.strength.label]} (${person.strength.score})`;
  return person.peak === person.strength.label
    ? current
    : `${current}, was ${STRENGTH_LABELS[person.peak]}`;
}

/**
 * The relationship radar's alerts with Copilot's own going-cold list folded
 * into "Going cold": the routine's items first (they are curated), then
 * anyone it did not already name. With no snapshot, Copilot's list alone.
 */
export function withGoingCold(
  snapshot: Relationships | null,
  derived: readonly GoingColdPerson[],
  now: Date = new Date(),
): Relationships | null {
  if (!snapshot && derived.length === 0) return null;
  const cold: RelationshipItem[] = [...(snapshot?.cold ?? [])];
  const named = new Set(cold.map((c) => c.who.trim().toLowerCase()));
  for (const person of derived) {
    if (cold.length >= 40) break;
    const who = (person.name ?? person.email).slice(0, 120);
    if (named.has(who.toLowerCase()) || named.has(person.email)) continue;
    named.add(who.toLowerCase());
    cold.push({
      who,
      company: null,
      kind: 'other',
      thread_id: person.threadId,
      since: person.lastContactAt,
      days: Math.min(3650, person.days),
      note: `${coldNote(person)} · ${person.summary}`.slice(0, 300),
    });
  }
  return {
    run_at: snapshot?.run_at ?? now.toISOString(),
    waiting: snapshot?.waiting ?? [],
    cold,
  };
}
