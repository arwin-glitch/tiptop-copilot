import { z } from 'zod';
import type { RelayDeal } from '@/lib/services/deal-relay';
import { sha256 } from '@/lib/util/hash';
import { isFreeEmailDomain, normalizeCompanyName, normalizeDomain } from '@/lib/util/text';

/**
 * The deal-sorter's rules, as pure functions.
 *
 * Everything here decides; nothing here reads or writes. The ingest service
 * (`services/deal-ingest.ts`) loads rows, asks these functions what to do, and
 * does it. Keeping the rules pure is what lets the whole move matrix, the
 * ownership predicates and the fold be tested exhaustively without a store.
 *
 * The rule the rest follows from: the routine owns only what it wrote and
 * nobody has changed since. A column is the routine's while its value still
 * equals what the routine last wrote there; a stage is the routine's while it
 * still equals the stage the routine last set and no person has recorded a
 * stage change or a decision since. The moment a person touches either, the
 * routine's view becomes a suggestion beside it and nothing more.
 */

export type Fit = 'likely' | 'possible' | 'unlikely';

export interface RoutineThread {
  id: string;
  subject?: string;
  date?: string;
}

export interface RoutineFounder {
  name: string;
  title?: string;
}

/** The routine's opinion of a deal's stage, with the evidence it rests on. */
export interface RoutineView {
  stage: string;
  evidence?: string;
  evidence_date: string;
  evidence_kind?: 'wire';
  pass_reason?: string;
}

/** One deal as it appeared in one relay message. `seq` orders them oldest first. */
export interface RelayObservation {
  seq: number;
  /** Slack message time, ISO. */
  ts: string;
  batch: string;
  part: number;
  deal: RelayDeal;
}

/** Everything the relay has said about one company, folded into one entry. */
export interface FoldedDeal {
  key: string;
  keys: string[];
  name: string;
  aka: string[];
  view: RoutineView | null;
  fit?: Fit;
  source?: string;
  summary?: string;
  sector?: string;
  round?: string;
  raise?: string;
  website?: string;
  founders: RoutineFounder[];
  next_step?: string;
  /** Whether some message decided next_step (possibly by leaving it out). */
  next_step_decided: boolean;
  first_seen?: string;
  last_activity?: string;
  threads: RoutineThread[];
  retract?: string;
  batch: string;
  part: number;
}

const AKA_CAP = 10;
const FOUNDER_CAP = 6;
const THREAD_CAP = 20;

/** Name used for matching: normalized, or the lowercased raw name if normalizing empties it. */
export function matchName(name: string): string {
  return normalizeCompanyName(name) || name.toLowerCase().trim();
}

function unionBy<T>(into: T[], items: readonly T[], id: (t: T) => string, cap: number): void {
  for (const item of items) {
    const key = id(item);
    const existing = into.find((x) => id(x) === key);
    if (existing !== undefined) {
      if (typeof existing !== 'object' || existing === null) continue;
      // Fill what the first sighting left blank; never replace it.
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        const record = existing as Record<string, unknown>;
        if (record[k] === undefined && v !== undefined) record[k] = v;
      }
    } else if (into.length < cap) {
      into.push(typeof item === 'object' && item !== null ? { ...item } : item);
    }
  }
}

const minDate = (a?: string, b?: string) => (!a ? b : !b ? a : a <= b ? a : b);
const maxDate = (a?: string, b?: string) => (!a ? b : !b ? a : a >= b ? a : b);

/**
 * How two stage views rank. `new` is the routine saying it saw no stage
 * signal, so it is not evidence: any real stage outranks it whatever its
 * date, and it only stands when nothing else was ever said. Between two real
 * stages (or two `new`s) the later evidence date ranks higher; 0 is a tie.
 */
export function compareViews(a: RoutineView, b: RoutineView): number {
  const aNew = a.stage === 'new';
  const bNew = b.stage === 'new';
  if (aNew !== bNew) return aNew ? -1 : 1;
  return a.evidence_date < b.evidence_date ? -1 : a.evidence_date > b.evidence_date ? 1 : 0;
}

/**
 * Fold every observation of one company into a single entry.
 *
 * - Scalars: the later non-empty value wins.
 * - `first_seen` takes the minimum and `last_activity` the maximum.
 * - `aka`, `founders` (by lowercase name) and `threads` (by id) are unioned.
 * - The stage view is the candidate with the latest `evidence_date`; a tie
 *   goes to the later message. Message order alone never decides, so a phase
 *   that saw only older evidence cannot regress a deal. A `new` candidate is
 *   "no signal" and never displaces a real stage (see `compareViews`).
 * - `next_step` comes from the newest message carrying a real stage or a
 *   next step.
 * - `retract` counts only when it is the newest message about the company.
 */
export function foldObservations(observations: readonly RelayObservation[]): FoldedDeal {
  if (observations.length === 0) throw new Error('foldObservations needs at least one');
  const sorted = [...observations].sort((a, b) => a.seq - b.seq);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const out: FoldedDeal = {
    key: first.deal.key,
    keys: [],
    name: first.deal.name,
    aka: [],
    view: null,
    founders: [],
    next_step_decided: false,
    threads: [],
    batch: last.batch,
    part: last.part,
  };

  for (const { deal } of sorted) {
    if (!out.keys.includes(deal.key)) out.keys.push(deal.key);
    out.name = deal.name;
    for (const field of [
      'fit',
      'source',
      'summary',
      'sector',
      'round',
      'raise',
      'website',
    ] as const) {
      const value = deal[field];
      if (value !== undefined) (out as unknown as Record<string, unknown>)[field] = value;
    }
    out.first_seen = minDate(out.first_seen, deal.first_seen);
    out.last_activity = maxDate(out.last_activity, deal.last_activity);
    unionBy(out.aka, deal.aka ?? [], (a) => a.toLowerCase(), AKA_CAP);
    unionBy(out.founders, deal.founders ?? [], (f) => f.name.toLowerCase(), FOUNDER_CAP);
    unionBy(out.threads, deal.threads ?? [], (t) => t.id.toLowerCase(), THREAD_CAP);

    if (deal.stage !== undefined && deal.evidence_date !== undefined) {
      const candidate = compactView({
        stage: deal.stage,
        evidence: deal.evidence,
        evidence_date: deal.evidence_date,
        evidence_kind: deal.evidence_kind,
        pass_reason: deal.pass_reason,
      });
      if (!out.view || compareViews(candidate, out.view) >= 0) out.view = candidate;
    }
    // A `new` post is "no signal": it neither sets nor clears the next step
    // unless it names one.
    if ((deal.stage !== undefined && deal.stage !== 'new') || deal.next_step !== undefined) {
      out.next_step = deal.next_step;
      out.next_step_decided = true;
    }
  }
  if (last.deal.retract !== undefined) out.retract = last.deal.retract;
  out.aka = out.aka.filter((a) => matchName(a) !== matchName(out.name));
  return out;
}

function compactView(view: RoutineView): RoutineView {
  const out: RoutineView = { stage: view.stage, evidence_date: view.evidence_date };
  if (view.evidence) out.evidence = view.evidence;
  if (view.evidence_kind) out.evidence_kind = view.evidence_kind;
  if (view.pass_reason) out.pass_reason = view.pass_reason;
  return out;
}

/**
 * Observations grouped by the routine's key, oldest first within each.
 *
 * The key is a slug of the name, so two different companies that share a
 * name share a key. Within a key, observations carrying different website
 * domains are split into separate groups (map key `<key>#<domain>`), exactly
 * as the matcher refuses a match whose domains differ; an observation with no
 * domain joins the key's first group.
 */
export function groupByKey(
  observations: readonly RelayObservation[],
): Map<string, RelayObservation[]> {
  const groups = new Map<string, { domain: string | null; list: RelayObservation[] }[]>();
  for (const o of [...observations].sort((a, b) => a.seq - b.seq)) {
    const domain = matchDomain(o.deal.website);
    const subgroups = groups.get(o.deal.key);
    if (!subgroups) {
      groups.set(o.deal.key, [{ domain, list: [o] }]);
      continue;
    }
    const home = domain
      ? (subgroups.find((g) => g.domain === domain) ?? subgroups.find((g) => g.domain === null))
      : subgroups[0];
    if (home) {
      if (domain && home.domain === null) home.domain = domain;
      home.list.push(o);
    } else {
      subgroups.push({ domain, list: [o] });
    }
  }
  const out = new Map<string, RelayObservation[]>();
  for (const [key, subgroups] of groups) {
    subgroups.forEach((g, i) => out.set(i === 0 ? key : `${key}#${g.domain}`, g.list));
  }
  return out;
}

/* --------------------------------------------------------------- sidecar */

/**
 * What the deal-sorter owns on one deal, kept as a `deal_facts` row
 * (`field = 'routine:state'`) so no migration is needed. Versions are
 * append-only, like every other fact.
 */
export interface RoutineSidecar {
  v: 1;
  keys: string[];
  aka: string[];
  created_by_routine: boolean;
  view: RoutineView | null;
  /** The stage the routine last set, and when (ISO). */
  stage_set: string | null;
  stage_set_at: string | null;
  /** Evidence date behind `stage_set`. */
  stage_evidence_date: string | null;
  fit: Fit | null;
  source: string | null;
  next_step: string | null;
  first_seen: string | null;
  last_activity: string | null;
  /** Threads already attached as deal sources. */
  threads: RoutineThread[];
  /** Column -> the value the routine last wrote there. */
  wrote: Record<string, string>;
  retract: string | null;
  batch: string | null;
  content_hash: string;
}

const optionalText = z.string().nullish().catch(null);
const SIDECAR_SCHEMA = z.object({
  v: z.literal(1).catch(1),
  keys: z.array(z.string()).catch([]),
  aka: z.array(z.string()).catch([]),
  created_by_routine: z.boolean().catch(false),
  view: z
    .object({
      stage: z.string(),
      evidence: z.string().optional(),
      evidence_date: z.string(),
      evidence_kind: z.literal('wire').optional(),
      pass_reason: z.string().optional(),
    })
    .nullable()
    .catch(null),
  stage_set: optionalText,
  stage_set_at: optionalText,
  stage_evidence_date: optionalText,
  fit: z.enum(['likely', 'possible', 'unlikely']).nullable().catch(null),
  source: optionalText,
  next_step: optionalText,
  first_seen: optionalText,
  last_activity: optionalText,
  threads: z
    .array(
      z.object({
        id: z.string(),
        subject: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .catch([]),
  wrote: z.record(z.string(), z.string()).catch({}),
  retract: optionalText,
  batch: optionalText,
  content_hash: z.string().catch(''),
});

/** A stored sidecar value -> its state, or null if it is not one. */
export function parseSidecar(value: string | null | undefined): RoutineSidecar | null {
  if (!value) return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  const parsed = SIDECAR_SCHEMA.parse(json);
  return {
    ...parsed,
    stage_set: parsed.stage_set ?? null,
    stage_set_at: parsed.stage_set_at ?? null,
    stage_evidence_date: parsed.stage_evidence_date ?? null,
    source: parsed.source ?? null,
    next_step: parsed.next_step ?? null,
    first_seen: parsed.first_seen ?? null,
    last_activity: parsed.last_activity ?? null,
    retract: parsed.retract ?? null,
    batch: parsed.batch ?? null,
  } as RoutineSidecar;
}

/**
 * Fold in what the sidecar remembers, so a message that has aged out of the
 * 30-day read window cannot shrink a deal: keys, aka and threads stay
 * unioned, dates stay min/max, and a view never goes back to older evidence.
 */
export function mergeWithSidecar(entry: FoldedDeal, sidecar: RoutineSidecar | null): FoldedDeal {
  if (!sidecar) return entry;
  const merged: FoldedDeal = {
    ...entry,
    keys: [...entry.keys],
    aka: [...entry.aka],
    founders: [...entry.founders],
    threads: entry.threads.map((t) => ({ ...t })),
  };
  for (const k of sidecar.keys) if (!merged.keys.includes(k)) merged.keys.push(k);
  unionBy(merged.aka, sidecar.aka, (a) => a.toLowerCase(), AKA_CAP);
  merged.aka = merged.aka.filter((a) => matchName(a) !== matchName(merged.name));
  unionBy(merged.threads, sidecar.threads, (t) => t.id.toLowerCase(), THREAD_CAP);
  merged.first_seen = minDate(entry.first_seen, sidecar.first_seen ?? undefined);
  merged.last_activity = maxDate(entry.last_activity, sidecar.last_activity ?? undefined);
  if (sidecar.view && (!entry.view || compareViews(sidecar.view, entry.view) > 0)) {
    merged.view = sidecar.view;
  }
  merged.fit = entry.fit ?? sidecar.fit ?? undefined;
  merged.source = entry.source ?? sidecar.source ?? undefined;
  if (!entry.next_step_decided) {
    merged.next_step = sidecar.next_step ?? undefined;
    merged.next_step_decided = sidecar.next_step !== null;
  }
  return merged;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = canonical(v);
  }
  return out;
}

/**
 * Hash of what a folded entry says, independent of message order, batch and
 * part. Equal to the stored sidecar's hash means the relay has nothing new to
 * say about the deal, which is why re-reading the whole window writes nothing.
 */
export function contentHash(entry: FoldedDeal): string {
  const body = canonical({
    keys: [...entry.keys].sort(),
    name: entry.name,
    aka: entry.aka.map((a) => a.toLowerCase()).sort(),
    view: entry.view,
    fit: entry.fit,
    source: entry.source,
    summary: entry.summary,
    sector: entry.sector,
    round: entry.round,
    raise: entry.raise,
    website: entry.website,
    founders: [...entry.founders].sort((a, b) => a.name.localeCompare(b.name)),
    next_step: entry.next_step,
    first_seen: entry.first_seen,
    last_activity: entry.last_activity,
    threads: [...entry.threads].sort((a, b) => a.id.localeCompare(b.id)),
    retract: entry.retract,
  });
  return sha256(JSON.stringify(body)).slice(0, 32);
}

/* -------------------------------------------------------------- matching */

export interface MatchCandidate {
  id: string;
  name: string;
  normalizedName: string;
  domain: string | null;
  archived: boolean;
  keys: readonly string[];
  aka: readonly string[];
}

export interface MatchQuery {
  keys: readonly string[];
  name: string;
  aka: readonly string[];
  website?: string | null;
}

export type MatchVia = 'key' | 'domain' | 'name' | 'aka';

/** The domain a query matches on, or null for none or a free-mail domain. */
export function matchDomain(website: string | null | undefined): string | null {
  const domain = normalizeDomain(website ?? null);
  return domain && !isFreeEmailDomain(domain) ? domain : null;
}

/**
 * Matches incoming relay entries against known deals, in a fixed order: the
 * routine's own key, then website domain, then normalized name, then aka
 * (either direction). A match of any kind whose non-null domain differs from
 * the incoming one is not a match — two different companies can share a
 * short name, and so its key. Archived rows are candidates too, so the caller
 * can see the match and leave it alone instead of creating a duplicate.
 */
export class DealIndex {
  private readonly byKey = new Map<string, MatchCandidate[]>();
  private readonly byDomain = new Map<string, MatchCandidate[]>();
  private readonly byName = new Map<string, MatchCandidate[]>();
  private readonly byAka = new Map<string, MatchCandidate[]>();

  add(candidate: MatchCandidate): void {
    const put = (map: Map<string, MatchCandidate[]>, key: string | null | undefined) => {
      if (!key) return;
      const list = map.get(key);
      if (!list) map.set(key, [candidate]);
      else if (!list.includes(candidate)) list.push(candidate);
    };
    for (const k of candidate.keys) put(this.byKey, k);
    put(
      this.byDomain,
      candidate.domain && !isFreeEmailDomain(candidate.domain) ? candidate.domain : null,
    );
    put(this.byName, candidate.normalizedName || matchName(candidate.name));
    for (const a of candidate.aka) put(this.byAka, matchName(a));
  }

  match(query: MatchQuery): { candidate: MatchCandidate; via: MatchVia } | null {
    const domain = matchDomain(query.website);
    // Applies to key hits too: the key is a slug of the name, so it is no
    // better evidence of identity than the name when the domains disagree.
    const compatible = (c: MatchCandidate) => !(domain && c.domain && c.domain !== domain);
    // A live match anywhere in the order beats an archived one earlier in it,
    // so archiving a duplicate does not cut the original off from updates.
    // With no live match, the first archived one is still reported, so the
    // caller leaves it alone rather than creating a duplicate.
    let archived: { candidate: MatchCandidate; via: MatchVia } | null = null;
    const pick = (list: readonly MatchCandidate[] | undefined, via: MatchVia) => {
      const usable = (list ?? []).filter(compatible);
      const live = usable.find((c) => !c.archived);
      if (live) return { candidate: live, via };
      if (!archived && usable[0]) archived = { candidate: usable[0], via };
      return null;
    };

    for (const key of query.keys) {
      const hit = pick(this.byKey.get(key), 'key');
      if (hit) return hit;
    }
    if (domain) {
      const hit = pick(this.byDomain.get(domain), 'domain');
      if (hit) return hit;
    }
    const name = matchName(query.name);
    const byName = pick(this.byName.get(name), 'name');
    if (byName) return byName;
    for (const aka of query.aka) {
      const hit = pick(this.byName.get(matchName(aka)), 'aka');
      if (hit) return hit;
    }
    return pick(this.byAka.get(name), 'aka') ?? archived;
  }
}

/* ----------------------------------------------------------- stage rules */

/**
 * Where the routine would move a deal it owns, or null for no move.
 *
 * | target                   | rule                                                    |
 * |--------------------------|---------------------------------------------------------|
 * | not a thesis stage       | never (view only)                                       |
 * | anything, from invested  | never                                                   |
 * | new                      | never                                                   |
 * | reviewing                | only from new                                           |
 * | invested                 | never; a deal short of IC review moves to ic_review     |
 * | anything else            | only on evidence at least as new as the stage's own     |
 *
 * Invested itself comes only from a person or from the Portfolio tab.
 */
export function planRoutineMove(input: {
  current: string;
  view: RoutineView | null;
  thesisKeys: readonly string[];
  stageEvidenceDate: string | null;
}): string | null {
  const { current, view, thesisKeys, stageEvidenceDate } = input;
  if (!view) return null;
  const target = view.stage;
  if (!thesisKeys.includes(target)) return null;
  if (current === 'invested') return null;
  if (target === 'new') return null;
  const fresh = !stageEvidenceDate || view.evidence_date >= stageEvidenceDate;
  if (target === 'invested') {
    if (current === 'ic_review' || !thesisKeys.includes('ic_review')) return null;
    return fresh ? 'ic_review' : null;
  }
  if (target === current) return null;
  if (target === 'reviewing') return current === 'new' && fresh ? 'reviewing' : null;
  return fresh ? target : null;
}

/**
 * The cheap half of ownership, decidable without a query: the deal is still
 * at the stage the routine last set (or, for a deal the routine never staged,
 * still `new`). Only when this holds is it worth asking about human events.
 */
export function stageUntouched(dealStage: string, sidecar: RoutineSidecar | null): boolean {
  return sidecar?.stage_set ? dealStage === sidecar.stage_set : dealStage === 'new';
}

/**
 * Whether the routine owns a deal's stage.
 *
 * With a stage it set: the deal still has that stage and no person has
 * recorded a stage change or decision since it set it. The equality alone
 * catches any change even if its audit row failed to write; the event check
 * catches a person moving A -> B -> A.
 *
 * Without one (a deal made by hand, or by "Analyse as deal"): only while it is
 * still `new` and no person has ever staged or decided it.
 *
 * `latestHumanStageEventAt` is the newest human stage event on the deal at
 * all, or since `stage_set_at` — either works, the comparison is here.
 */
export function routineOwnsStage(input: {
  dealStage: string;
  sidecar: RoutineSidecar | null;
  latestHumanStageEventAt: string | null;
}): boolean {
  const { dealStage, sidecar, latestHumanStageEventAt } = input;
  if (!stageUntouched(dealStage, sidecar)) return false;
  if (!latestHumanStageEventAt) return true;
  if (!sidecar?.stage_set || !sidecar.stage_set_at) return false;
  return Date.parse(latestHumanStageEventAt) <= Date.parse(sidecar.stage_set_at);
}

/* ---------------------------------------------------------- column rules */

/** The deal columns the routine may fill, and the relay field each comes from. */
export const ROUTINE_COLUMNS = {
  website: 'website',
  domain: 'website',
  vertical: 'sector',
  funding_stage: 'round',
  round_size: 'raise',
  referral_source: 'source',
  product_summary: 'summary',
  outcome: 'pass_reason',
} as const;

export type RoutineColumn = keyof typeof ROUTINE_COLUMNS;

/** The column values an entry proposes. `outcome` only when the deal ends up passed. */
export function routineColumnValues(
  entry: FoldedDeal,
  resultingStage: string,
): Partial<Record<RoutineColumn, string>> {
  const values: Partial<Record<RoutineColumn, string>> = {};
  if (entry.website) {
    values.website = entry.website;
    const domain = normalizeDomain(entry.website);
    if (domain) values.domain = domain;
  }
  if (entry.sector) values.vertical = entry.sector;
  if (entry.round) values.funding_stage = entry.round;
  if (entry.raise) values.round_size = entry.raise;
  if (entry.source) values.referral_source = entry.source;
  if (entry.summary) values.product_summary = entry.summary;
  if (resultingStage === 'passed' && entry.view?.stage === 'passed' && entry.view.pass_reason) {
    values.outcome = `Passed — ${entry.view.pass_reason}`;
  }
  return values;
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/**
 * Ownership by equality. A column is written only if it is blank, or it still
 * holds exactly what the routine last wrote there. A human correction or an
 * AI extraction breaks the equality, and from then on the column is never
 * touched again (its `wrote` entry is dropped).
 */
export function planColumnWrites(
  deal: Readonly<Record<string, unknown>>,
  incoming: Partial<Record<RoutineColumn, string>>,
  wrote: Readonly<Record<string, string>>,
): { patch: Partial<Record<RoutineColumn, string>>; wrote: Record<string, string> } {
  const nextWrote: Record<string, string> = {};
  for (const [column, value] of Object.entries(wrote)) {
    if (deal[column] === value) nextWrote[column] = value;
  }
  const patch: Partial<Record<RoutineColumn, string>> = {};
  for (const [column, value] of Object.entries(incoming) as [RoutineColumn, string][]) {
    const current = deal[column];
    const owned = !isBlank(current) && wrote[column] !== undefined && current === wrote[column];
    if (!isBlank(current) && !owned) continue;
    if (current !== value) patch[column] = value;
    nextWrote[column] = value;
  }
  return { patch, wrote: nextWrote };
}

/**
 * A retracted deal is archived only if nothing about it is anyone's but the
 * routine's: it created it, still owns its stage, and nobody has decided,
 * noted, tasked or restored it. Otherwise the retraction is shown as a banner
 * with a human "Not a deal" button.
 */
export function canArchiveOnRetract(input: {
  createdByRoutine: boolean;
  ownsStage: boolean;
  decisions: number;
  notes: number;
  tasks: number;
  humanRestores: number;
}): boolean {
  return (
    input.createdByRoutine &&
    input.ownsStage &&
    input.decisions === 0 &&
    input.notes === 0 &&
    input.tasks === 0 &&
    input.humanRestores === 0
  );
}
