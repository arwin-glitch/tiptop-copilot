import type { DataStore } from '@/lib/db/store';
import { chunk, listAllPages } from '@/lib/db/paging';
import {
  canArchiveOnRetract,
  contentHash,
  DealIndex,
  foldObservations,
  groupByKey,
  matchDomain,
  matchName,
  mergeWithSidecar,
  parseSidecar,
  planColumnWrites,
  planRoutineMove,
  routineColumnValues,
  routineOwnsStage,
  stageUntouched,
  type FoldedDeal,
  type MatchCandidate,
  type RelayObservation,
  type RoutineSidecar,
  type RoutineThread,
} from '@/lib/deals/routine-state';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type {
  AuditEvent,
  Deal,
  DealDecision,
  DealFact,
  DealPerson,
  DealSource,
  PortfolioCompany,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { normalizeCompanyName, normalizeDomain } from '@/lib/util/text';
import { getActiveThesis } from './thesis';

/**
 * Folding the deal-sorter's relay posts into the pipeline, and mirroring the
 * Portfolio tab into the Invested stage.
 *
 * The rules themselves live in `lib/deals/routine-state.ts`; this file loads
 * what they need once per pull, applies their answers, and writes. What it
 * owns on each deal lives in a sidecar `deal_facts` row (`routine:state`), so
 * there is no migration: the routine's key and aliases, its stage view and the
 * evidence behind it, what it last wrote to each column, and a hash of the
 * relay content, which is what makes an unchanged 30-day window cost zero
 * writes.
 *
 * Nothing here writes `deal_decisions` (its actor is always a person), writes
 * a column a person has changed, or moves a stage a person has set.
 */

export const SIDECAR_FIELD = 'routine:state';
/** Audit reason on a system move into Invested because of the Portfolio tab. */
export const PORTFOLIO_MIRROR_REASON = 'in Portfolio tab';

export interface DealIngestCounts {
  created: number;
  updated: number;
  unchanged: number;
  moved: number;
  /** Deals left with a routine view that differs from their stage. */
  suggested: number;
  skipped_portfolio: number;
  skipped_archived: number;
  /** Retractions for companies that were never a deal here. */
  skipped_retracted: number;
  retracted: number;
  retract_flagged: number;
  failed: number;
  /** Portfolio companies given an Invested deal. */
  mirrored: number;
  /** Existing deals moved into Invested because they are in the Portfolio tab. */
  mirror_moved: number;
}

export function zeroCounts(): DealIngestCounts {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    moved: 0,
    suggested: 0,
    skipped_portfolio: 0,
    skipped_archived: 0,
    skipped_retracted: 0,
    retracted: 0,
    retract_flagged: 0,
    failed: 0,
    mirrored: 0,
    mirror_moved: 0,
  };
}

/**
 * A UUID derived from a seed. Deals the ingest creates get one, so two app
 * instances folding the same relay window (a deploy overlap, or the standby
 * pointed at the same database) collide on the primary key instead of each
 * inserting its own copy: the loser's insert fails, is counted, and its next
 * pull finds the winner's row.
 */
export function stableUuid(seed: string): string {
  const h = sha256(seed);
  const variant = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The id a relay company's deal is created with. */
export function relayDealId(organizationId: string, key: string, website?: string | null): string {
  return stableUuid(`deal-relay:${organizationId}:${key}:${matchDomain(website) ?? ''}`);
}

/** The id a Portfolio company's mirrored Invested deal is created with. */
export function mirrorDealId(organizationId: string, portfolioCompanyId: string): string {
  return stableUuid(`portfolio-mirror:${organizationId}:${portfolioCompanyId}`);
}

/**
 * An error message fit for a log line that must never carry deal content: a
 * Postgres constraint message quotes the offending values ("Key (name)=(…)"),
 * so quoted and parenthesised parts are dropped.
 */
export function scrubErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    message
      .replace(/\([^)]*\)/g, '(…)')
      .replace(/"[^"]*"/g, '"…"')
      .replace(/'[^']*'/g, "'…'")
      .slice(0, 120) || 'unknown'
  );
}

/* --------------------------------------------------------------- sidecars */

export interface StoredSidecar {
  row: DealFact;
  state: RoutineSidecar;
}

function pickCurrent(rows: readonly DealFact[]): Map<string, StoredSidecar> {
  const out = new Map<string, StoredSidecar>();
  for (const row of rows) {
    const state = parseSidecar(row.value);
    if (!state) continue;
    const existing = out.get(row.deal_id);
    // Two current rows can only come from an interrupted write; the higher
    // version is the later one.
    if (!existing || row.version > existing.row.version) out.set(row.deal_id, { row, state });
  }
  return out;
}

/** Every deal's current sidecar, in one paged query. */
export async function readSidecars(
  store: DataStore,
  organizationId: string,
): Promise<Map<string, StoredSidecar>> {
  const rows = (await listAllPages(
    store,
    'deal_facts',
    organizationId,
    { eq: { field: SIDECAR_FIELD }, isNull: ['superseded_by'] },
    [{ field: 'deal_id', direction: 'asc' }],
  )) as DealFact[];
  return pickCurrent(rows);
}

/** One deal's current sidecar, or null if the deal-sorter has never touched it. */
export async function readSidecar(
  store: DataStore,
  organizationId: string,
  dealId: string,
): Promise<StoredSidecar | null> {
  const rows = (await store.list('deal_facts', organizationId, {
    eq: { deal_id: dealId, field: SIDECAR_FIELD },
    isNull: ['superseded_by'],
  })) as DealFact[];
  return pickCurrent(rows).get(dealId) ?? null;
}

function sidecarRow(
  organizationId: string,
  dealId: string,
  state: RoutineSidecar,
  previous: DealFact | null,
  nowIso: string,
  part: number | null,
): DealFact {
  return {
    id: newId(),
    organization_id: organizationId,
    deal_id: dealId,
    field: SIDECAR_FIELD,
    value: JSON.stringify(state),
    source_type: 'model_inference',
    evidence_quote: state.view?.evidence ?? null,
    citation_id: state.batch ? `${state.batch}#${part ?? 1}`.slice(0, 120) : null,
    confidence: null,
    version: (previous?.version ?? 0) + 1,
    superseded_by: null,
    created_by: null,
    created_at: nowIso,
  };
}

/** Append-only: insert version n+1, then point version n at it. */
async function writeSidecar(
  store: DataStore,
  organizationId: string,
  dealId: string,
  state: RoutineSidecar,
  previous: DealFact | null,
  nowIso: string,
  part: number | null,
): Promise<void> {
  const row = sidecarRow(organizationId, dealId, state, previous, nowIso, part);
  await store.insert('deal_facts', row);
  if (previous) {
    await store.update('deal_facts', organizationId, previous.id, { superseded_by: row.id });
  }
}

function emptySidecar(): RoutineSidecar {
  return {
    v: 1,
    keys: [],
    aka: [],
    created_by_routine: false,
    view: null,
    stage_set: null,
    stage_set_at: null,
    stage_evidence_date: null,
    fit: null,
    source: null,
    next_step: null,
    first_seen: null,
    last_activity: null,
    threads: [],
    wrote: {},
    retract: null,
    batch: null,
    content_hash: '',
  };
}

/* ----------------------------------------------------------- human events */

const HUMAN_STAGE_ACTIONS = ['deal.stage_changed', 'deal.decision_recorded'];

/**
 * The newest time a person staged or decided this deal, or null if nobody
 * ever has: a `deal_decisions` row (always human), or a stage-change or
 * decision audit row with a user attached.
 */
export async function latestHumanStageEvent(
  store: DataStore,
  organizationId: string,
  dealId: string,
): Promise<string | null> {
  const [decisions, events] = await Promise.all([
    store.list(
      'deal_decisions',
      organizationId,
      { eq: { deal_id: dealId } },
      { orderBy: [{ field: 'decided_at', direction: 'desc' }], limit: 1 },
    ) as Promise<DealDecision[]>,
    store.list(
      'audit_events',
      organizationId,
      { eq: { entity_id: dealId }, in: { action: HUMAN_STAGE_ACTIONS }, notNull: ['user_id'] },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    ) as Promise<AuditEvent[]>,
  ]);
  const times = [decisions[0]?.decided_at, events[0]?.created_at].filter(
    (t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t)),
  );
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** Whether the deal-sorter currently owns this deal's stage (for the deal page). */
export async function routineOwnsDealStage(
  store: DataStore,
  organizationId: string,
  deal: Pick<Deal, 'id' | 'stage'>,
  sidecar: RoutineSidecar | null,
): Promise<boolean> {
  if (!stageUntouched(deal.stage, sidecar)) return false;
  const latest = await latestHumanStageEvent(store, organizationId, deal.id);
  return routineOwnsStage({ dealStage: deal.stage, sidecar, latestHumanStageEventAt: latest });
}

/**
 * A stage move of the routine's whose sidecar write was lost. The deal sits
 * at the stage the newest system `deal.stage_synced` (not the Portfolio
 * mirror's) moved it to, after the sidecar's `stage_set_at`, and no person
 * has staged or decided it since: the move happened, only its bookkeeping
 * failed, so the stage is still the routine's. Returns that move, or null.
 */
export async function lostRoutineMove(
  store: DataStore,
  organizationId: string,
  deal: Pick<Deal, 'id' | 'stage'>,
  sidecar: RoutineSidecar | null,
): Promise<{ at: string; evidenceDate: string | null } | null> {
  if (!sidecar?.stage_set || deal.stage === sidecar.stage_set) return null;
  const [latest] = (await store.list(
    'audit_events',
    organizationId,
    { eq: { entity_id: deal.id, action: 'deal.stage_synced' }, isNull: ['user_id'] },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  if (!latest || latest.metadata?.to !== deal.stage || latest.metadata?.reason) return null;
  const at = Date.parse(latest.created_at);
  if (Number.isNaN(at)) return null;
  if (sidecar.stage_set_at && at <= Date.parse(sidecar.stage_set_at)) return null;
  const human = await latestHumanStageEvent(store, organizationId, deal.id);
  if (human && Date.parse(human) >= at) return null;
  const evidence = latest.metadata?.evidence_date;
  return { at: latest.created_at, evidenceDate: typeof evidence === 'string' ? evidence : null };
}

/* ------------------------------------------------------------------ rows */

/** A deal row with every optional column empty. Never names `search_vector`. */
export function blankDealRow(
  organizationId: string,
  name: string,
  receivedAt: string,
  nowIso: string,
): Deal {
  return {
    id: newId(),
    organization_id: organizationId,
    company_name: name,
    normalized_name: normalizeCompanyName(name) || name.toLowerCase().trim(),
    website: null,
    domain: null,
    stage: 'new',
    industry: null,
    vertical: null,
    geography: null,
    funding_stage: null,
    round_size: null,
    amount_raised: null,
    valuation_or_cap: null,
    existing_investors: [],
    requested_check: null,
    referral_source: null,
    received_at: receivedAt,
    product_summary: null,
    customer: null,
    problem: null,
    solution: null,
    ai_usage: null,
    traction: null,
    revenue: null,
    growth: null,
    customer_count: null,
    pipeline: null,
    business_model: null,
    pricing: null,
    market: null,
    competition: null,
    team: null,
    founder_market_fit: null,
    gtm_motion: null,
    defensibility: null,
    data_advantage: null,
    risks: [],
    open_questions: [],
    outcome: null,
    is_archived: false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function personRow(
  organizationId: string,
  dealId: string,
  name: string,
  role: string | null,
  nowIso: string,
): DealPerson {
  return {
    id: sha256(`${dealId}:${name}`).slice(0, 32),
    organization_id: organizationId,
    deal_id: dealId,
    name,
    role,
    email: null,
    linkedin_url: null,
    background: null,
    created_at: nowIso,
  };
}

function threadSourceRow(
  organizationId: string,
  dealId: string,
  thread: RoutineThread,
  nowIso: string,
): DealSource {
  return {
    id: sha256(`${dealId}:email_thread:${thread.id}`).slice(0, 32),
    organization_id: organizationId,
    deal_id: dealId,
    kind: 'email_thread',
    ref_id: thread.id,
    label: thread.subject ?? 'Gmail thread',
    url: null,
    occurred_at: thread.date ? `${thread.date}T00:00:00.000Z` : null,
    created_at: nowIso,
  };
}

function candidateOf(deal: Deal, sidecar: RoutineSidecar | null): MatchCandidate {
  return {
    id: deal.id,
    name: deal.company_name,
    normalizedName: deal.normalized_name || matchName(deal.company_name),
    domain: deal.domain ?? normalizeDomain(deal.website),
    archived: deal.is_archived,
    keys: sidecar?.keys ?? [],
    aka: sidecar?.aka ?? [],
  };
}

/* ----------------------------------------------------------------- ingest */

interface IngestContext {
  organizationId: string;
  nowIso: string;
  thesisKeys: string[];
  dealsById: Map<string, Deal>;
  sidecars: Map<string, StoredSidecar>;
  index: DealIndex;
  portfolio: PortfolioCompany[];
  portfolioIndex: DealIndex;
  counts: DealIngestCounts;
}

function inPortfolio(
  ctx: IngestContext,
  name: string,
  website: string | null | undefined,
): boolean {
  return ctx.portfolioIndex.match({ keys: [], name, aka: [], website }) !== null;
}

/**
 * Apply the relay's observations (oldest first) to the pipeline, then mirror
 * the Portfolio tab into Invested. Safe to call with no observations: that is
 * the mirror alone, which is what runs when the relay cannot be read.
 */
export async function ingestDealRelay(
  store: DataStore,
  organizationId: string,
  observations: readonly RelayObservation[],
  opts: { now?: Date; rejected?: number } = {},
): Promise<DealIngestCounts> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const [deals, sidecars, portfolio, thesis] = await Promise.all([
    listAllPages(store, 'deals', organizationId, undefined, [
      { field: 'received_at', direction: 'desc' },
    ]) as Promise<Deal[]>,
    readSidecars(store, organizationId),
    store.list('portfolio_companies', organizationId, { eq: { is_archived: false } }) as Promise<
      PortfolioCompany[]
    >,
    getActiveThesis(store, organizationId),
  ]);

  const ctx: IngestContext = {
    organizationId,
    nowIso,
    thesisKeys: thesis.deal_stages.map((s) => s.key),
    dealsById: new Map(deals.map((d) => [d.id, d])),
    sidecars,
    index: new DealIndex(),
    portfolio,
    portfolioIndex: new DealIndex(),
    counts: zeroCounts(),
  };
  for (const deal of deals) ctx.index.add(candidateOf(deal, sidecars.get(deal.id)?.state ?? null));
  for (const pc of portfolio) {
    ctx.portfolioIndex.add({
      id: pc.id,
      name: pc.name,
      normalizedName: pc.normalized_name || matchName(pc.name),
      domain: pc.domain ?? normalizeDomain(pc.website),
      archived: false,
      keys: [],
      aka: [],
    });
  }

  // Resolve each routine key to a target: a deal that already exists, or a
  // new company. Keys that resolve to the same target are folded together.
  const targets = new Map<string, RelayObservation[]>();
  const stableIds = new Map<string, string>();
  const pending = new DealIndex();
  let clusters = 0;
  for (const group of groupByKey(observations).values()) {
    const folded = foldObservations(group);
    const query = {
      keys: folded.keys,
      name: folded.name,
      aka: folded.aka,
      website: folded.website,
    };
    let id = ctx.index.match(query)?.candidate.id ?? pending.match(query)?.candidate.id;
    if (!id) {
      // The deal this company was first created as, if a person has since
      // renamed or re-domained it past recognition; otherwise a new one.
      const stable = relayDealId(organizationId, folded.key, folded.website);
      if (ctx.dealsById.has(stable)) {
        id = stable;
      } else {
        id = `new:${clusters++}`;
        stableIds.set(id, stable);
      }
    }
    if (id.startsWith('new:')) {
      pending.add({
        id,
        name: folded.name,
        normalizedName: matchName(folded.name),
        domain: matchDomain(folded.website),
        archived: false,
        keys: folded.keys,
        aka: folded.aka,
      });
    }
    const list = targets.get(id);
    if (list) list.push(...group);
    else targets.set(id, [...group]);
  }

  const creates: NewDeal[] = [];
  for (const [id, group] of targets) {
    const folded = foldObservations(group);
    try {
      if (id.startsWith('new:')) {
        const planned = planNewDeal(ctx, folded, stableIds.get(id) ?? newId());
        if (planned) creates.push(planned);
      } else {
        const deal = ctx.dealsById.get(id);
        if (deal) await applyToExisting(store, ctx, deal, folded);
      }
    } catch (error) {
      ctx.counts.failed++;
      log.warn('A deal relay entry could not be applied', { reason: scrubErrorMessage(error) });
    }
  }
  await writeNewDeals(store, ctx, creates);

  await mirrorPortfolio(store, ctx);

  const c = ctx.counts;
  if (c.created + c.updated + c.moved + c.retracted + c.mirrored + c.mirror_moved > 0) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'deal.routine_sync',
      entityType: 'deal',
      entityId: null,
      metadata: { ...c, rejected: opts.rejected ?? 0 },
    });
  }
  return c;
}

interface NewDeal {
  deal: Deal;
  people: DealPerson[];
  sources: DealSource[];
  sidecar: DealFact;
}

function planNewDeal(ctx: IngestContext, folded: FoldedDeal, stableId: string): NewDeal | null {
  const { counts, thesisKeys, nowIso, organizationId } = ctx;
  if (folded.retract) {
    counts.skipped_retracted++;
    return null;
  }
  // Follow-ons, declined outbound intros and invested companies: the
  // Portfolio tab already covers them, and the mirror gives each its deal.
  if (inPortfolio(ctx, folded.name, folded.website)) {
    counts.skipped_portfolio++;
    return null;
  }

  const view = folded.view;
  let stage = thesisKeys.includes('new') ? 'new' : (thesisKeys[0] ?? 'new');
  if (view && thesisKeys.includes(view.stage)) {
    // Invested comes from a person or the Portfolio tab, never the routine.
    if (view.stage !== 'invested') stage = view.stage;
    else if (thesisKeys.includes('ic_review')) stage = 'ic_review';
  }

  const receivedDay = folded.first_seen ?? view?.evidence_date;
  const deal = blankDealRow(
    organizationId,
    folded.name,
    receivedDay ? `${receivedDay}T00:00:00.000Z` : nowIso,
    nowIso,
  );
  // Never reuse an id already taken, even by a deal created earlier this pull.
  deal.id = ctx.dealsById.has(stableId) ? newId() : stableId;
  deal.stage = stage;
  const { patch, wrote } = planColumnWrites({}, routineColumnValues(folded, stage), {});
  Object.assign(deal, patch);

  const seen = new Set<string>();
  const people = folded.founders
    .filter((f) => {
      const k = f.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((f) => personRow(organizationId, deal.id, f.name, f.title ?? null, nowIso));
  const sources = folded.threads.map((t) => threadSourceRow(organizationId, deal.id, t, nowIso));

  const state: RoutineSidecar = {
    ...emptySidecar(),
    keys: folded.keys,
    aka: folded.aka,
    created_by_routine: true,
    view,
    stage_set: stage,
    stage_set_at: nowIso,
    stage_evidence_date: view?.evidence_date ?? null,
    fit: folded.fit ?? null,
    source: folded.source ?? null,
    next_step: folded.next_step ?? null,
    first_seen: folded.first_seen ?? null,
    last_activity: folded.last_activity ?? null,
    threads: folded.threads,
    wrote,
    batch: folded.batch,
    content_hash: contentHash(folded),
  };

  counts.created++;
  if (isSuggestion(view, stage, thesisKeys)) counts.suggested++;
  ctx.dealsById.set(deal.id, deal);
  ctx.index.add(candidateOf(deal, state));
  return {
    deal,
    people,
    sources,
    sidecar: sidecarRow(organizationId, deal.id, state, null, nowIso, folded.part),
  };
}

/**
 * Insert new deals a chunk at a time, each chunk's sidecars straight after its
 * deals (the sidecar is what makes a deal the routine's), then its people and
 * sources. A failed chunk is counted and the rest carry on: one bad insert
 * never takes the Portfolio mirror, or the other chunks, down with it.
 */
async function writeNewDeals(
  store: DataStore,
  ctx: IngestContext,
  creates: NewDeal[],
): Promise<void> {
  for (const part of chunk(creates, 100)) {
    try {
      await store.insertMany(
        'deals',
        part.map((c) => c.deal),
      );
    } catch (error) {
      ctx.counts.created -= part.length;
      ctx.counts.failed += part.length;
      for (const c of part) ctx.dealsById.delete(c.deal.id);
      log.warn('New deals from the relay could not be saved', {
        count: part.length,
        reason: scrubErrorMessage(error),
      });
      continue;
    }
    try {
      await store.insertMany(
        'deal_facts',
        part.map((c) => c.sidecar),
      );
      for (const people of chunk(
        part.flatMap((c) => c.people),
        100,
      )) {
        await store.insertMany('deal_people', people);
      }
      for (const sources of chunk(
        part.flatMap((c) => c.sources),
        100,
      )) {
        await store.insertMany('deal_sources', sources);
      }
    } catch (error) {
      ctx.counts.failed++;
      log.warn('Details of new relay deals could not be saved', {
        count: part.length,
        reason: scrubErrorMessage(error),
      });
    }
  }
}

/** Whether a routine view is a suggestion beside a deal's stage. `new` never is. */
function isSuggestion(
  view: RoutineSidecar['view'],
  stage: string,
  thesisKeys: readonly string[],
): boolean {
  return Boolean(
    view && view.stage !== 'new' && thesisKeys.includes(view.stage) && view.stage !== stage,
  );
}

async function applyToExisting(
  store: DataStore,
  ctx: IngestContext,
  deal: Deal,
  folded: FoldedDeal,
): Promise<void> {
  const { counts, organizationId, nowIso, thesisKeys } = ctx;
  if (deal.is_archived) {
    // Someone (or a retraction) archived it; a re-post never resurrects it.
    counts.skipped_archived++;
    return;
  }
  const stored = ctx.sidecars.get(deal.id) ?? null;
  const merged = mergeWithSidecar(folded, stored?.state ?? null);
  const hash = contentHash(merged);
  if (stored && stored.state.content_hash === hash) {
    counts.unchanged++;
    return;
  }
  // A move of the routine's whose sidecar write failed is still its own: pick
  // the bookkeeping back up instead of treating the stage as a person's.
  let previous = stored?.state ?? null;
  const lost = await lostRoutineMove(store, organizationId, deal, previous);
  if (previous && lost) {
    previous = {
      ...previous,
      stage_set: deal.stage,
      stage_set_at: lost.at,
      stage_evidence_date: lost.evidenceDate ?? previous.stage_evidence_date,
    };
  }

  const base = previous ?? emptySidecar();
  const next: RoutineSidecar = {
    ...base,
    keys: merged.keys,
    aka: merged.aka,
    view: merged.view,
    fit: merged.fit ?? null,
    source: merged.source ?? null,
    next_step: merged.next_step ?? null,
    first_seen: merged.first_seen ?? null,
    last_activity: merged.last_activity ?? null,
    retract: merged.retract ?? null,
    batch: merged.batch,
    content_hash: hash,
  };
  const save = () =>
    writeSidecar(store, organizationId, deal.id, next, stored?.row ?? null, nowIso, merged.part);

  // A portfolio company's deal is the mirror's: the routine only annotates it.
  if (
    inPortfolio(ctx, deal.company_name, deal.website ?? deal.domain) ||
    inPortfolio(ctx, merged.name, merged.website)
  ) {
    await save();
    counts.updated++;
    return;
  }

  if (merged.retract) {
    let archived = false;
    if (base.created_by_routine && stageUntouched(deal.stage, previous)) {
      const latest = await latestHumanStageEvent(store, organizationId, deal.id);
      const owns = routineOwnsStage({
        dealStage: deal.stage,
        sidecar: previous,
        latestHumanStageEventAt: latest,
      });
      if (owns) {
        const [decisions, notes, tasks, restores] = await Promise.all([
          store.count('deal_decisions', organizationId, { eq: { deal_id: deal.id } }),
          store.count('deal_notes', organizationId, { eq: { deal_id: deal.id } }),
          store.count('tasks', organizationId, { eq: { deal_id: deal.id } }),
          store.count('audit_events', organizationId, {
            eq: { entity_id: deal.id, action: 'deal.restored' },
            notNull: ['user_id'],
          }),
        ]);
        if (
          canArchiveOnRetract({
            createdByRoutine: true,
            ownsStage: true,
            decisions,
            notes,
            tasks,
            humanRestores: restores,
          })
        ) {
          await store.update('deals', organizationId, deal.id, { is_archived: true });
          deal.is_archived = true;
          await recordAudit(store, {
            organizationId,
            userId: null,
            action: 'deal.archived',
            entityType: 'deal',
            entityId: deal.id,
            metadata: { by: 'deal-sorter', reason: merged.retract },
          });
          archived = true;
        }
      }
    }
    if (archived) counts.retracted++;
    else counts.retract_flagged++;
    await save();
    return;
  }

  // Stage: move only what the routine still owns, by the move matrix.
  const from = deal.stage;
  let stage = deal.stage;
  const target = planRoutineMove({
    current: deal.stage,
    view: merged.view,
    thesisKeys,
    stageEvidenceDate: previous?.stage_evidence_date ?? null,
  });
  if (target && merged.view && stageUntouched(deal.stage, previous)) {
    const latest = await latestHumanStageEvent(store, organizationId, deal.id);
    if (
      routineOwnsStage({
        dealStage: deal.stage,
        sidecar: previous,
        latestHumanStageEventAt: latest,
      })
    ) {
      stage = target;
      next.stage_set = target;
      next.stage_set_at = nowIso;
      next.stage_evidence_date = merged.view.evidence_date;
    }
  }
  const moved = stage !== deal.stage;
  if (
    !moved &&
    previous?.stage_set === deal.stage &&
    merged.view?.stage === deal.stage &&
    (!previous.stage_evidence_date || merged.view.evidence_date > previous.stage_evidence_date)
  ) {
    next.stage_evidence_date = merged.view.evidence_date;
  }

  // Columns: ownership by equality.
  const { patch, wrote } = planColumnWrites(
    deal as unknown as Record<string, unknown>,
    routineColumnValues(merged, stage),
    previous?.wrote ?? {},
  );
  const dealPatch: Partial<Deal> = { ...patch };
  // The pass outcome the routine wrote goes once the deal is no longer passed
  // (a person's own outcome text is never touched).
  if (stage !== 'passed' && wrote.outcome !== undefined && deal.outcome === wrote.outcome) {
    dealPatch.outcome = null;
    delete wrote.outcome;
  }
  next.wrote = wrote;
  if (moved) dealPatch.stage = stage;
  if (Object.keys(dealPatch).length > 0) {
    await store.update('deals', organizationId, deal.id, dealPatch);
    Object.assign(deal, dealPatch);
  }
  if (moved) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'deal.stage_synced',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        from,
        to: stage,
        evidence_date: merged.view?.evidence_date ?? null,
        batch: merged.batch,
      },
    });
    counts.moved++;
  }
  if (isSuggestion(merged.view, stage, thesisKeys)) counts.suggested++;

  // People: add-only, by lowercase name.
  if (merged.founders.length > 0) {
    const people = (await store.list('deal_people', organizationId, {
      eq: { deal_id: deal.id },
    })) as DealPerson[];
    const known = new Set(people.map((p) => p.name.toLowerCase()));
    const missing = merged.founders.filter((f) => {
      const k = f.name.toLowerCase();
      if (known.has(k)) return false;
      known.add(k);
      return true;
    });
    if (missing.length > 0) {
      await store.insertMany(
        'deal_people',
        missing.map((f) => personRow(organizationId, deal.id, f.name, f.title ?? null, nowIso)),
      );
    }
  }

  // Sources: threads not attached before.
  const attached = new Set(base.threads.map((t) => t.id.toLowerCase()));
  for (const thread of merged.threads) {
    if (attached.has(thread.id.toLowerCase())) continue;
    await store.upsert('deal_sources', threadSourceRow(organizationId, deal.id, thread, nowIso), [
      'deal_id',
      'kind',
      'ref_id',
    ]);
  }
  next.threads = merged.threads;

  await save();
  counts.updated++;
}

/* ------------------------------------------------------ portfolio mirror */

function portfolioDealRow(organizationId: string, pc: PortfolioCompany, nowIso: string): Deal {
  const deal = blankDealRow(organizationId, pc.name, pc.created_at || nowIso, nowIso);
  deal.normalized_name = pc.normalized_name || deal.normalized_name;
  deal.stage = 'invested';
  deal.website = pc.website;
  deal.domain = pc.domain ?? normalizeDomain(pc.website);
  deal.vertical = pc.sector ?? null;
  deal.geography = pc.geography ?? null;
  deal.funding_stage = pc.current_stage;
  deal.product_summary = pc.description ?? null;
  deal.referral_source = pc.deal_source ?? null;
  deal.existing_investors = (pc.co_investors ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  return deal;
}

/**
 * Every company in the Portfolio tab shows on /deals under Invested, by
 * Arwin's decision of 2026-09-23 (amending D-012). A company with no matching
 * deal (normalized name or domain) gets one, filled from its Portfolio row; a
 * matching deal at another stage is moved to Invested once, as a system move
 * audited with no user and the reason "in Portfolio tab". No decision row is
 * written: `deal_decisions` records people's decisions only.
 *
 * Idempotent, and it does not fight a person: a deal it created or has
 * already moved once is never moved again, and neither is a deal a person has
 * staged or decided since the company joined the Portfolio tab, so someone
 * moving it out of Invested always stands. A match to an archived deal is
 * left alone.
 */
async function mirrorPortfolio(store: DataStore, ctx: IngestContext): Promise<void> {
  const { organizationId, nowIso, counts } = ctx;
  if (!ctx.thesisKeys.includes('invested')) return;
  const creates: { deal: Deal; pc: PortfolioCompany }[] = [];

  for (const pc of ctx.portfolio) {
    try {
      const hit = ctx.index.match({
        keys: [],
        name: pc.name,
        aka: [],
        website: pc.website ?? pc.domain,
      });
      if (hit?.candidate.archived) continue;
      if (!hit) {
        const id = mirrorDealId(organizationId, pc.id);
        // Its deal exists but no longer matches: a person renamed it.
        if (ctx.dealsById.has(id)) continue;
        const deal = portfolioDealRow(organizationId, pc, nowIso);
        deal.id = id;
        creates.push({ deal, pc });
        ctx.dealsById.set(deal.id, deal);
        ctx.index.add(candidateOf(deal, null));
        continue;
      }
      const deal = ctx.dealsById.get(hit.candidate.id);
      if (!deal || deal.stage === 'invested') continue;
      // Once per deal: the mirror created it, or has moved it before.
      const history = (await store.list('audit_events', organizationId, {
        eq: { entity_id: deal.id },
        in: { action: ['deal.stage_synced', 'deal.created'] },
      })) as AuditEvent[];
      if (history.some((e) => e.metadata?.reason === PORTFOLIO_MIRROR_REASON)) continue;
      // A person who has staged or decided it since the company joined the
      // Portfolio tab has the last word (an invest decision recorded before
      // the company was added, then a move out, included).
      const human = await latestHumanStageEvent(store, organizationId, deal.id);
      const joined = Date.parse(pc.created_at);
      if (human && (Number.isNaN(joined) || Date.parse(human) >= joined)) continue;
      const from = deal.stage;
      await store.update('deals', organizationId, deal.id, { stage: 'invested' });
      deal.stage = 'invested';
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'deal.stage_synced',
        entityType: 'deal',
        entityId: deal.id,
        metadata: {
          from,
          to: 'invested',
          reason: PORTFOLIO_MIRROR_REASON,
          portfolio_company_id: pc.id,
        },
      });
      counts.mirror_moved++;
    } catch (error) {
      counts.failed++;
      log.warn('A Portfolio company could not be mirrored into Invested', {
        reason: scrubErrorMessage(error),
      });
    }
  }

  for (const part of chunk(creates, 100)) {
    try {
      await store.insertMany(
        'deals',
        part.map((c) => c.deal),
      );
    } catch (error) {
      counts.failed += part.length;
      log.warn('Portfolio companies could not be mirrored into Invested', {
        count: part.length,
        reason: scrubErrorMessage(error),
      });
      continue;
    }
    for (const { deal, pc } of part) {
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'deal.created',
        entityType: 'deal',
        entityId: deal.id,
        metadata: {
          stage: 'invested',
          reason: PORTFOLIO_MIRROR_REASON,
          portfolio_company_id: pc.id,
        },
      });
    }
    counts.mirrored += part.length;
  }
}
