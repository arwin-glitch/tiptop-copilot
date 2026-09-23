import type { Metadata } from 'next';
import { Suspense } from 'react';
import { after } from 'next/server';
import { requireAuth } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { listDeals } from '@/lib/services/deals';
import { latestAnalysesByDeal } from '@/lib/services/deal-analysis';
import { readSidecars } from '@/lib/services/deal-ingest';
import {
  dealRelayConfigured,
  getDealRelayStatus,
  pullDealsFromSlack,
  readDealsVersion,
} from '@/lib/services/deal-relay';
import { getActiveThesis } from '@/lib/services/thesis';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { VersionWatcher } from '@/components/shell/version-watcher';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { DealsFilterBar, ComparePanel } from '@/components/deals/deals-client';
import { DealSorterStatus } from '@/components/deals/deal-sorter-status';
import { DealsTable } from '@/components/deals/deals-table';
import {
  asFitFilter,
  asSortKey,
  chooseColumnMode,
  FIT_FILTERS,
  sortRows,
  type DealRow,
  type FitFilter,
  type SortDirection,
  type SortKey,
} from '@/lib/deals/pipeline-view';
import { describeDealSorterStatus } from '@/lib/deals/sorter-status';

export const metadata: Metadata = { title: 'Deals' };
export const dynamic = 'force-dynamic';

/** How long the page waits for the relay pull before rendering what is stored. */
const PULL_BUDGET_MS = 8_000;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const stage = single(params.stage) ?? '';
  const q = single(params.q) ?? '';
  const fit = asFitFilter(single(params.fit));
  const archived = single(params.archived) === '1';
  const sort = asSortKey(single(params.sort));
  const direction: SortDirection = single(params.dir) === 'asc' ? 'asc' : 'desc';

  return (
    <PageShell>
      <PageHeader
        title="Deals"
        subtitle="Everything in the pipeline, with the current recommendation and how much of it rests on real evidence."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <DealsContent
          stage={stage}
          q={q}
          fit={fit}
          archived={archived}
          sort={sort}
          direction={direction}
        />
      </Suspense>
    </PageShell>
  );
}

async function DealsContent({
  stage,
  q,
  fit,
  archived,
  sort,
  direction,
}: {
  stage: string;
  q: string;
  fit: FitFilter | null;
  archived: boolean;
  sort: SortKey;
  direction: SortDirection;
}) {
  const auth = await requireAuth();
  const store = getStore();
  const orgId = auth.organizationId;

  // Fold in whatever the deal-sorter has posted to #deal-relay (and mirror the
  // Portfolio tab into Invested) before listing. Bounded: if Slack is slow the
  // page renders what is stored, and the pull finishes after the response —
  // `after` keeps it alive — for the open-tab watcher to pick up.
  const pull = pullDealsFromSlack(store, orgId).catch(() => null);
  const finished = await settlesWithin(pull, PULL_BUDGET_MS);
  if (!finished) {
    after(async () => {
      await pull;
    });
  }

  const [thesis, live, archivedDeals, sidecars, analysisCount] = await Promise.all([
    getActiveThesis(store, orgId, auth.userId),
    listDeals(orgId),
    archived ? listDeals(orgId, { archivedOnly: true }) : Promise.resolve(null),
    readSidecars(store, orgId),
    store.count('deal_analyses', orgId),
  ]);
  const archivedCount = archivedDeals
    ? archivedDeals.length
    : await store.count('deals', orgId, { eq: { is_archived: true } });

  const base = archivedDeals ?? live;
  const fitOf = (id: string) => sidecars.get(id)?.state.fit ?? null;
  let matching = base;
  if (q) {
    // Server-side search only when there is a query; everything else filters
    // the one list in memory.
    const hits = await listDeals(orgId, {
      search: q,
      ...(archived ? { archivedOnly: true } : {}),
    });
    const ids = new Set(hits.map((d) => d.id));
    matching = base.filter((d) => ids.has(d.id));
  }

  const counts = new Map<string, number>();
  for (const d of matching) {
    if (fit && fitOf(d.id) !== fit) continue;
    counts.set(d.stage, (counts.get(d.stage) ?? 0) + 1);
  }
  const fitCounts: Record<string, number> = {};
  for (const d of matching) {
    if (stage && d.stage !== stage) continue;
    const f = fitOf(d.id);
    if (f) fitCounts[f] = (fitCounts[f] ?? 0) + 1;
  }
  const deals = matching.filter(
    (d) => (!stage || d.stage === stage) && (!fit || fitOf(d.id) === fit),
  );

  const analyses = await latestAnalysesByDeal(
    store,
    orgId,
    deals.map((d) => d.id),
  );
  const aiAvailable = getAI().available();
  const mode = chooseColumnMode({ aiAvailable, anyAnalysis: analysisCount > 0 });
  const stageByKey = new Map(thesis.deal_stages.map((s) => [s.key, s]));

  const rows: DealRow[] = deals.map((deal) => {
    const analysis = analyses.get(deal.id);
    const side = sidecars.get(deal.id)?.state ?? null;
    const view = side?.view ?? null;
    const suggested =
      view && view.stage !== deal.stage && deal.stage !== 'invested'
        ? (stageByKey.get(view.stage)?.label ?? null)
        : null;
    return {
      id: deal.id,
      companyName: deal.company_name,
      stageLabel: stageByKey.get(deal.stage)?.label ?? deal.stage,
      stageOrder: stageByKey.get(deal.stage)?.order ?? Number.MAX_SAFE_INTEGER,
      vertical: deal.vertical,
      productSummary: deal.product_summary,
      receivedAt: deal.received_at,
      // A human override outranks the model's own recommendation, exactly as
      // it does on the deal page. Null means never analysed, which is a
      // distinct state from any recommendation value.
      recommendation: analysis
        ? (analysis.human_override?.recommendation ?? analysis.recommendation)
        : null,
      qualityScore: analysis?.quality_score ?? null,
      dataCompleteness: analysis?.data_completeness ?? null,
      confidence: analysis?.confidence ?? null,
      facts: [deal.revenue, deal.customer_count, deal.funding_stage].filter(Boolean).join(' · '),
      fit: side?.fit ?? null,
      source: deal.referral_source ?? side?.source ?? null,
      lastActivity: side?.last_activity ?? null,
      nextStep: side?.next_step ?? null,
      evidence: view?.evidence ?? null,
      suggestedStageLabel: suggested,
      isRoutine: Boolean(side),
    };
  });

  const status = getDealRelayStatus(orgId);
  const statusView = describeDealSorterStatus({
    isDemo: auth.isDemo,
    state: status.state,
    missing: status.missing,
    needed: status.needed,
    lastRun: status.lastRun
      ? {
          ts: status.lastRun.ts,
          backfillDone: status.lastRun.heartbeat.backfill_done,
          posted: status.lastRun.heartbeat.posted,
        }
      : null,
    dealCount: live.length,
    routineDealCount: live.filter((d) => sidecars.has(d.id)).length,
    counts: status.counts,
    rejected: status.rejected.total,
    now: new Date(),
    timezone: auth.profile.timezone,
  });
  const watch = dealRelayConfigured() || auth.isDemo;
  const filtered = Boolean(q || stage || fit);
  // With nothing listed, the empty state says the same thing; once is enough.
  const showStrip = deals.length > 0 || filtered || archived;

  return (
    <>
      {watch ? (
        <VersionWatcher
          version={await readDealsVersion(store, orgId)}
          endpoint="/api/deals/version"
        />
      ) : null}
      {showStrip ? <DealSorterStatus view={statusView} /> : null}

      <DealsFilterBar
        stages={thesis.deal_stages}
        counts={Object.fromEntries(counts)}
        stage={stage}
        q={q}
        fit={fit}
        fits={FIT_FILTERS.map((f) => ({ key: f, count: fitCounts[f] ?? 0 }))}
        archived={archived}
        archivedCount={archivedCount}
      />

      {deals.length === 0 ? (
        <EmptyState
          className="mt-5"
          title={filtered ? 'No deals match' : archived ? 'Nothing archived' : 'No deals yet'}
          description={
            filtered
              ? 'Clear the filters, or widen the search.'
              : archived
                ? 'Deals marked "Not a deal" land here, and can be restored.'
                : `${statusView.message}${
                    aiAvailable
                      ? ' You can also open a pitch email in the Inbox and choose "Analyse as deal".'
                      : ''
                  }`
          }
          action={
            filtered || archived
              ? { label: filtered ? 'Clear filters' : 'Back to the pipeline', href: '/deals' }
              : statusView.configLink
                ? { label: 'See what is configured', href: '/diagnostics' }
                : aiAvailable
                  ? { label: 'Go to Inbox', href: '/inbox' }
                  : undefined
          }
        />
      ) : (
        <>
          {aiAvailable && !archived ? (
            <ComparePanel deals={deals.map((d) => ({ id: d.id, company_name: d.company_name }))} />
          ) : null}

          <DealsTable
            rows={sortRows(rows, sort, direction)}
            sort={sort}
            direction={direction}
            mode={mode}
            archived={archived}
          />
        </>
      )}
    </>
  );
}

/** Whether `promise` settles within `ms`; never rejects. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
