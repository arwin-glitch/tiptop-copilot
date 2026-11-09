import { listMySpaces } from './spaces';
import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { formatOffset, meetingPagePath } from '@/lib/notes/api';
import { notesAccess } from '@/lib/notes/flag';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import type { Meeting, MeetingSpeaker, TranscriptSegment } from '@/lib/types/notes';
import { fundTwoLpHref } from '@/lib/records-tabs';
import { log } from '@/lib/security/redact';
import type {
  CrmList,
  CrmNote,
  Deal,
  KnowledgeDocument,
  MeetingNote,
  NetworkContact,
  PortfolioCompany,
  Task,
} from '@/lib/types/domain';
import { searchRecords } from './crm';
import { INDUSTRY_LABELS, recordField, TITLE_LABELS } from './search-preview';
import { readFollowUps } from './follow-ups';
import { isTeamVisibleNote } from '@/lib/notes/visibility';
import { canSeeMeeting } from './notes';
import { getRelationshipIndex } from './relationships';
import { harmonicTypeahead } from '@/lib/integrations/harmonic';
import { isPerson, nameFor, type RelationshipIndex } from '@/lib/network/evidence';

/**
 * One search box across the app: deals, portfolio companies, Fund II LPs,
 * people, meetings, tasks, documents, and the CRM's lists and the companies
 * and people on them. Each source is a small substring match (ILIKE through
 * the store), capped per source, so a keystroke never scans a whole table.
 * Results carry an in-app href only.
 *
 * The CRM results come last and the palette shows them as their own "Lists"
 * group (companies, people, lists and notes); a company or person carries its
 * record id, which the palette's preview panel reads. Their tables arrive by a hand-applied migration; until then those
 * sources simply return nothing, like any other source that fails.
 */

export type SearchKind =
  | 'deal'
  | 'portfolio'
  | 'lp'
  | 'person'
  | 'meeting'
  | 'task'
  | 'document'
  | 'crm_list'
  | 'crm_company'
  | 'crm_person'
  | 'crm_note'
  | 'space'
  | 'harmonic_person'
  | 'harmonic_company';

export interface SearchResult {
  kind: SearchKind;
  label: string;
  sub: string | null;
  href: string;
  /**
   * A CRM company's or person's id: the palette's preview panel reads it
   * (/api/search/preview). Absent for everything else.
   */
  recordId?: string;
  /**
   * The query's words (lowercased) that the label or sub contains, for the
   * palette to bold. Empty when none of them appears there.
   */
  matched?: string[];
  /** A company's bare domain, for a logo; deals, portfolio and CRM companies only. */
  domain?: string | null;
}

const PER_SOURCE = 6;

const CRM_LIST_KIND: Record<CrmList['entity_type'], string> = {
  deal: 'Deal list',
  company: 'Company list',
  person: 'Person list',
};
const MAX_QUERY = 80;
/**
 * The longest one source may hold the box up. A source still running then
 * (an unindexed notes scan, a cold mail index) is left out of this answer
 * rather than making every other result wait.
 */
export const SOURCE_WAIT_MS = 2_500;

function within<T>(promise: Promise<T>, fallback: T, ms = SOURCE_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** Lowercase with every space and dot dropped: "GTM Fund" and "gtmfund" meet. */
export const squash = (text: string) => text.toLowerCase().replace(/[\s.]+/g, '');

/** Most words a query is split into: one store call per word, in parallel. */
const MAX_WORDS = 4;

/**
 * The query's words, lowercased, as Affinity searches: split on spaces, words
 * of one letter dropped, repeats dropped, at most four. "Harmony Nordgren"
 * becomes ["harmony", "nordgren"]; one word means the plain search.
 */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/**
 * How well a text meets a query: above every word count when it holds the
 * whole phrase (spaces in or out), otherwise how many of the words it holds.
 */
function scoreText(text: string, needle: string, words: string[]): number {
  const hay = text.toLowerCase();
  if (hay.includes(needle) || squash(hay).includes(squash(needle))) return words.length + 1;
  return words.filter((w) => hay.includes(w)).length;
}

/**
 * Rows merged from a phrase search and one search per word: each once (first
 * sighting wins), the whole phrase first, then every word, then more words
 * before fewer. Sorting is stable, so within a tier a source keeps its order.
 */
function rankByWords<T>(
  rows: T[],
  text: (row: T) => string,
  key: (row: T) => string,
  needle: string,
  words: string[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) if (!byKey.has(key(row))) byKey.set(key(row), row);
  return [...byKey.values()]
    .map((row, i) => ({ row, i, score: scoreText(text(row), needle, words) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.row);
}

/**
 * Everyone Nick's mail and calendar have seen whose name or address matches,
 * as Affinity finds a person you have only emailed. Strongest (most threads
 * and meetings) first; the fund's own addresses and automated senders never.
 */
export function mailPeopleMatching(
  index: RelationshipIndex,
  query: string,
  limit = PER_SOURCE,
): { email: string; name: string | null; threads: number; meetings: number }[] {
  const needle = query.trim().toLowerCase();
  const flat = squash(query);
  if (flat.length < 2) return [];
  // Several words: a name or address holding the whole phrase ranks 0-2 as
  // before, then one holding every word (3), then fewer words (4 and down).
  const words = queryWords(query);
  const multi = words.length > 1;
  const hits: {
    email: string;
    name: string | null;
    threads: number;
    meetings: number;
    rank: number;
  }[] = [];
  for (const [email, entry] of index.byAddress) {
    if (!isPerson(index, email)) continue;
    const name = nameFor(index, email);
    const hay = `${name ?? ''} ${email}`.toLowerCase();
    const phrase = hay.includes(needle) || squash(hay).includes(flat);
    let rank: number;
    if (phrase) {
      const lowerName = (name ?? '').toLowerCase();
      rank =
        lowerName === needle || email === needle
          ? 0
          : lowerName.startsWith(needle) || lowerName.split(/\s+/).some((w) => w.startsWith(needle))
            ? 1
            : 2;
    } else {
      if (!multi) continue;
      const held = words.filter((w) => hay.includes(w)).length;
      if (held === 0) continue;
      rank = 3 + (words.length - held);
    }
    hits.push({ email, name, threads: entry.threads.size, meetings: entry.meetings.size, rank });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || b.threads + b.meetings - (a.threads + a.meetings))
    .slice(0, limit)
    .map(({ rank: _rank, ...rest }) => rest);
}

/**
 * Lines of Kraken Notes transcripts that match (D-076), for someone with
 * the feature on: only meetings they may see, each result opening the
 * transcript at that moment.
 */
async function transcriptResults(
  store: DataStore,
  viewer: AuthContext,
  query: string,
): Promise<SearchResult[]> {
  const access = await notesAccess(store, viewer);
  if (!access.enabled) return [];
  const org = viewer.organizationId;
  const hits = (await store.search(
    'transcript_segments',
    org,
    query,
    ['text', 'edited_text'],
    undefined,
    30,
  )) as { row: TranscriptSegment }[];
  if (hits.length === 0) return [];
  const ids = [...new Set(hits.map((h) => h.row.meeting_id))];
  const [meetings, speakers] = await Promise.all([
    store.list('meetings', org, { in: { id: ids } }) as Promise<Meeting[]>,
    store.list('meeting_speakers', org, { in: { meeting_id: ids } }) as Promise<MeetingSpeaker[]>,
  ]);
  const seen = new Map(
    meetings.filter((m) => canSeeMeeting(m, viewer.userId) && !m.deleted_at).map((m) => [m.id, m]),
  );
  const results: SearchResult[] = [];
  for (const { row } of hits) {
    const meeting = seen.get(row.meeting_id);
    if (!meeting) continue;
    const who = speakers.find(
      (s) => s.meeting_id === row.meeting_id && s.cluster_key === row.cluster_key,
    );
    const text = (row.edited_text ?? row.text).replace(/\s+/g, ' ').trim();
    results.push({
      kind: 'meeting',
      label: meeting.title,
      sub: `Transcript · ${formatOffset(row.start_ms)} ${who ? speakerDisplayName(who) : 'Guest'}: ${
        text.length > 90 ? `${text.slice(0, 89)}…` : text
      }`,
      href: meetingPagePath(meeting.id, row.start_ms),
    });
    if (results.length >= PER_SOURCE) break;
  }
  return results;
}

export async function searchEverything(
  store: DataStore,
  organizationId: string,
  rawQuery: string,
  /** Who is searching: with Kraken Notes on for them, transcripts are searched too. */
  viewer?: AuthContext,
): Promise<SearchResult[]> {
  const query = rawQuery.trim().slice(0, MAX_QUERY);
  if (query.length < 2) return [];
  const needle = query.toLowerCase();
  // "GTM Fund" should find "GTMfund": with spaces in the query, the names are
  // searched with them taken out as well.
  const joined = /\s/.test(query) ? query.replace(/\s+/g, '') : null;
  const like = (columns: string[], term = query) => ({ textSearch: { columns, query: term } });
  // Several words: each source also finds rows holding any one word, then
  // ranks them (whole phrase, every word, more words, fewer). One word: the
  // plain phrase search, exactly as before.
  const words = queryWords(query);
  const multi = words.length > 1;
  const rank = <T>(rows: T[], text: (row: T) => string, key: (row: T) => string) =>
    rankByWords(rows, text, key, needle, words);
  /**
   * One store call for the phrase, plus (several words) one per word in
   * parallel, each held to the source wait, merged and ranked.
   */
  const wide = async <T extends { id: string }>(
    run: (term: string, limit: number) => Promise<T[]>,
    text: (row: T) => string,
  ): Promise<T[]> => {
    if (!multi) return run(query, PER_SOURCE);
    const lists = await Promise.all([
      within(run(query, PER_SOURCE), [] as T[]),
      ...words.map((w) => within(run(w, PER_SOURCE * 2), [] as T[])),
    ]);
    return rank(lists.flat(), text, (r) => r.id).slice(0, PER_SOURCE);
  };

  const safe = async <T>(label: string, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await within(run(), [] as T[]);
    } catch {
      log.warn('Search source failed', { source: label });
      return [];
    }
  };
  const records = async (term: string) => {
    const r = await searchRecords(store, organizationId, term, PER_SOURCE);
    return r.ok ? r.value : [];
  };

  const [
    deals,
    portfolio,
    people,
    meetings,
    tasks,
    documents,
    followUps,
    crmLists,
    crmRecords,
    crmNotes,
    transcripts,
    spaces,
    mailPeople,
    harmonic,
  ] = await Promise.all([
    safe('deals', () =>
      wide(
        (term, limit) =>
          store.list('deals', organizationId, like(['company_name'], term), {
            limit,
          }) as Promise<Deal[]>,
        (d) => d.company_name,
      ),
    ),
    safe('portfolio', () =>
      wide(
        (term, limit) =>
          store.list('portfolio_companies', organizationId, like(['name'], term), {
            limit,
          }) as Promise<PortfolioCompany[]>,
        (p) => p.name,
      ),
    ),
    safe('people', () =>
      wide(
        (term, limit) =>
          store.list(
            'network_contacts',
            organizationId,
            like(['full_name', 'company', 'email'], term),
            { limit },
          ) as Promise<NetworkContact[]>,
        (c) => `${c.full_name} ${c.company ?? ''} ${c.email ?? ''}`,
      ),
    ),
    safe('meetings', async () => {
      const titled = (term: string, limit = PER_SOURCE) =>
        within(
          store.list(
            'meeting_notes',
            organizationId,
            { textSearch: { columns: ['title'], query: term } },
            { limit, orderBy: [{ field: 'occurred_at', direction: 'desc' }] },
          ) as Promise<MeetingNote[]>,
          [] as MeetingNote[],
        );
      const rows = (
        await Promise.all([
          titled(query),
          joined ? titled(joined) : [],
          ...(multi ? words.map((w) => titled(w, PER_SOURCE * 2)) : []),
        ])
      ).flat();
      const merged = multi
        ? rank(
            rows,
            (n) => n.title,
            (n) => n.id,
          )
        : [...new Map(rows.map((note) => [note.id, note])).values()];
      return merged.filter((note) => isTeamVisibleNote(note)).slice(0, PER_SOURCE);
    }),
    safe('tasks', () =>
      wide(
        (term, limit) =>
          store.list('tasks', organizationId, like(['title'], term), { limit }) as Promise<Task[]>,
        (t) => t.title,
      ),
    ),
    safe('documents', () =>
      wide(
        (term, limit) =>
          store.list('knowledge_documents', organizationId, like(['title', 'filename'], term), {
            limit,
          }) as Promise<KnowledgeDocument[]>,
        (doc) => `${doc.title} ${doc.filename}`,
      ),
    ),
    readFollowUps(store, organizationId).catch(() => null),
    safe('crm lists', () =>
      wide(
        (term, limit) =>
          store.list('crm_lists', organizationId, like(['name'], term), {
            limit,
            orderBy: [{ field: 'position', direction: 'asc' }],
          }) as Promise<CrmList[]>,
        (list) => list.name,
      ),
    ),
    // Ranked (exact name, then prefixes); a Result, so a missing table is an
    // empty source rather than a throw. Several words: searched per word too,
    // then ranked by words held, keeping searchRecords' order within a tier.
    safe('crm records', async () => {
      const rows = (
        await Promise.all([
          within(records(query), []),
          joined ? within(records(joined), []) : [],
          ...(multi ? words.map((w) => within(records(w), [])) : []),
        ])
      ).flat();
      const merged = multi
        ? rank(
            rows,
            (r) => `${r.name} ${r.domain ?? ''} ${r.primary_email ?? ''}`,
            (r) => r.id,
          )
        : [...new Map(rows.map((r) => [r.id, r])).values()];
      return merged.slice(0, PER_SOURCE);
    }),
    // Notes by title or text, newest first: a small capped ILIKE like the rest.
    // Several words: the text is scanned only for the phrase and the longest
    // word; the other words are matched on titles.
    safe('crm notes', async () => {
      const notes = (columns: string[], term: string, limit = PER_SOURCE) =>
        within(
          store.list('crm_notes', organizationId, like(columns, term), {
            limit,
            orderBy: [{ field: 'occurred_at', direction: 'desc' }],
          }) as Promise<CrmNote[]>,
          [] as CrmNote[],
        );
      if (!multi) return notes(['title', 'content'], query);
      const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
      const lists = await Promise.all([
        notes(['title', 'content'], query),
        ...words.map((w) =>
          notes(w === longest ? ['title', 'content'] : ['title'], w, PER_SOURCE * 2),
        ),
      ]);
      return rank(
        lists.flat(),
        (n) => `${n.title ?? ''} ${n.content}`,
        (n) => n.id,
      ).slice(0, PER_SOURCE);
    }),
    viewer && viewer.organizationId === organizationId
      ? safe('transcripts', () => transcriptResults(store, viewer, query))
      : Promise.resolve([] as SearchResult[]),
    // Spaces are members only: just the ones this person is in or invited to.
    viewer
      ? listMySpaces(store, viewer)
          .then((r) => {
            if (!r.ok) return [];
            if (!multi)
              return r.value
                .filter((a) => a.space.name.toLowerCase().includes(needle))
                .slice(0, PER_SOURCE);
            return rank(
              r.value.filter((a) => scoreText(a.space.name, needle, words) > 0),
              (a) => a.space.name,
              (a) => a.space.id,
            ).slice(0, PER_SOURCE);
          })
          .catch(() => [])
      : Promise.resolve([]),
    // People from Nick's own mail and calendar, met or only emailed. The
    // index is cached for five minutes; a cold build is not waited for.
    safe('mail people', async () => {
      const index = await getRelationshipIndex(store, organizationId, { ownAddresses: [] });
      return index.ok ? mailPeopleMatching(index.value, query) : [];
    }),
    // Harmonic: people and companies nobody has met yet, as Affinity finds
    // them. Nothing without HARMONIC_API_KEY.
    safe('harmonic', () => harmonicTypeahead(query)),
  ]);

  const results: SearchResult[] = [];
  for (const d of deals) {
    results.push({
      kind: 'deal',
      label: d.company_name,
      sub: d.product_summary ?? null,
      href: `/deals/${d.id}`,
      domain: d.domain ?? null,
    });
  }
  for (const p of portfolio) {
    results.push({
      kind: 'portfolio',
      label: p.name,
      sub: 'Portfolio company',
      href: `/portfolio/${p.id}`,
      domain: p.domain ?? null,
    });
  }
  const lps = followUps?.state === 'ok' ? (followUps.snapshot.lpPipeline?.lps ?? []) : [];
  const lpText = (l: (typeof lps)[number]) => `${l.who} ${l.firm ?? ''}`;
  const lpHits = multi
    ? rank(
        lps.filter((l) => scoreText(lpText(l), needle, words) > 0),
        lpText,
        (l) => `${l.who}|${l.firm ?? ''}|${l.stage}`,
      )
    : lps.filter((l) => lpText(l).toLowerCase().includes(needle));
  for (const lp of lpHits.slice(0, PER_SOURCE)) {
    results.push({
      kind: 'lp',
      label: lp.who,
      sub: [lp.firm, `Fund II · ${lp.stage.replace('_', ' ')}`].filter(Boolean).join(' · '),
      href: fundTwoLpHref(lp.stage),
    });
  }
  for (const c of people) {
    results.push({
      kind: 'person',
      label: c.full_name,
      sub: [c.title, c.company].filter(Boolean).join(' · ') || null,
      href: `/network?q=${encodeURIComponent(c.full_name)}`,
    });
  }
  // Someone already shown from the lists or the contacts is not shown twice.
  const shown = new Set<string>();
  for (const c of people) if (c.email) shown.add(c.email.toLowerCase());
  for (const r of crmRecords) for (const e of r.emails ?? []) shown.add(e.toLowerCase());
  for (const p of mailPeople) {
    if (shown.has(p.email)) continue;
    const seen = [
      p.threads ? `${p.threads} email${p.threads === 1 ? '' : 's'}` : null,
      p.meetings ? `${p.meetings} meeting${p.meetings === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    results.push({
      kind: 'person',
      label: p.name ?? p.email,
      sub: [p.name ? p.email : null, seen ? `From your mail · ${seen}` : 'From your mail']
        .filter(Boolean)
        .join(' · '),
      href: `/network?tab=people&source=mail&q=${encodeURIComponent(p.email)}`,
    });
  }
  for (const m of meetings) {
    results.push({
      kind: 'meeting',
      label: m.title,
      sub: m.occurred_at.slice(0, 10),
      href: `/meetings?q=${encodeURIComponent(m.title)}`,
    });
  }
  results.push(...transcripts);
  for (const t of tasks) {
    // A deleted task stays in the table (so it is never suggested again), not in results.
    if (t.status === 'cancelled') continue;
    results.push({
      kind: 'task',
      label: t.title,
      sub: t.status === 'complete' ? 'Completed task' : 'Task',
      href: '/tasks',
    });
  }
  for (const doc of documents) {
    results.push({
      kind: 'document',
      label: doc.title,
      sub: doc.filename,
      href: `/knowledge?q=${encodeURIComponent(doc.title)}`,
    });
  }
  for (const list of crmLists) {
    results.push({
      kind: 'crm_list',
      label: list.name,
      sub: [CRM_LIST_KIND[list.entity_type], list.archived ? 'archived' : null]
        .filter(Boolean)
        .join(' · '),
      href: `/lists/${list.id}`,
    });
  }
  for (const record of crmRecords) {
    const company = record.kind === 'company';
    results.push({
      kind: company ? 'crm_company' : 'crm_person',
      label: record.name,
      sub:
        [
          company ? record.domain : record.primary_email,
          recordField(record, company ? INDUSTRY_LABELS : TITLE_LABELS),
        ]
          .filter(Boolean)
          .join(' • ') || null,
      href: `/lists/records/${record.id}`,
      recordId: record.id,
      ...(company ? { domain: record.domain ?? null } : {}),
    });
  }
  for (const note of crmNotes) {
    const target = note.record_ids[0];
    const text = (note.title?.trim() || note.content).replace(/\s+/g, ' ').trim();
    results.push({
      kind: 'crm_note',
      label: text.length > 80 ? `${text.slice(0, 79)}…` : text || 'Note',
      sub:
        [note.entity_names.slice(0, 2).join(', '), note.author, note.occurred_at?.slice(0, 10)]
          .filter(Boolean)
          .join(' • ') || null,
      href: target ? `/lists/records/${target}?tab=notes` : '/knowledge?tab=lists',
      ...(target ? { recordId: target } : {}),
    });
  }
  // Harmonic last, as its own group, leaving out anyone already shown by name.
  const named = new Set(results.map((r) => r.label.trim().toLowerCase()));
  for (const h of harmonic) {
    if (named.has(h.name.toLowerCase())) continue;
    results.push({
      kind: h.kind === 'person' ? 'harmonic_person' : 'harmonic_company',
      label: h.name,
      sub: h.sub,
      href: `/network/harmonic?kind=${h.kind}&id=${encodeURIComponent(h.id)}`,
    });
  }
  for (const access of spaces) {
    results.push({
      kind: 'space',
      label: access.space.name,
      sub: access.invited ? 'Space · invite waiting' : 'Space',
      href: `/spaces/${access.space.id}`,
    });
  }
  // Which query words each result shows, for the palette to bold.
  for (const r of results) {
    const hay = `${r.label} ${r.sub ?? ''}`.toLowerCase();
    r.matched = words.filter((w) => hay.includes(w));
  }
  return results;
}
