import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listDeals } from '@/lib/services/deals';
import { getActiveThesis } from '@/lib/services/thesis';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { DealsFilterBar, ComparePanel } from '@/components/deals/deals-client';
import { DealsTable } from '@/components/deals/deals-table';
import {
  asSortKey,
  sortRows,
  type DealRow,
  type SortDirection,
  type SortKey,
} from '@/lib/deals/pipeline-view';
import type { DealAnalysis } from '@/lib/types/domain';

export const metadata: Metadata = { title: 'Deals' };
export const dynamic = 'force-dynamic';

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const stage = single(params.stage) ?? '';
  const q = single(params.q) ?? '';
  const sort = asSortKey(single(params.sort));
  const direction: SortDirection = single(params.dir) === 'asc' ? 'asc' : 'desc';

  return (
    <PageShell>
      <PageHeader
        title="Deals"
        subtitle="Everything in the pipeline, with the current recommendation and how much of it rests on real evidence."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <DealsContent stage={stage} q={q} sort={sort} direction={direction} />
      </Suspense>
    </PageShell>
  );
}

async function DealsContent({
  stage,
  q,
  sort,
  direction,
}: {
  stage: string;
  q: string;
  sort: SortKey;
  direction: SortDirection;
}) {
  const auth = await requireAuth();
  const store = getStore();
  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);
  const deals = await listDeals(auth.organizationId, {
    stage: stage || undefined,
    search: q || undefined,
  });

  const analyses = new Map<string, DealAnalysis>();
  for (const deal of deals) {
    const versions = (await store.list(
      'deal_analyses',
      auth.organizationId,
      { eq: { deal_id: deal.id } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
    )) as DealAnalysis[];
    if (versions[0]) analyses.set(deal.id, versions[0]);
  }

  const counts = new Map<string, number>();
  const allDeals = await listDeals(auth.organizationId);
  for (const d of allDeals) counts.set(d.stage, (counts.get(d.stage) ?? 0) + 1);

  const rows: DealRow[] = deals.map((deal) => {
    const analysis = analyses.get(deal.id);
    return {
      id: deal.id,
      companyName: deal.company_name,
      stageLabel: thesis.deal_stages.find((s) => s.key === deal.stage)?.label ?? deal.stage,
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
    };
  });

  return (
    <>
      <DealsFilterBar
        stages={thesis.deal_stages}
        counts={Object.fromEntries(counts)}
        stage={stage}
        q={q}
      />

      {deals.length === 0 ? (
        <EmptyState
          className="mt-5"
          title={q || stage ? 'No deals match' : 'No deals yet'}
          description={
            q || stage
              ? 'Clear the filters, or widen the search.'
              : 'Deals are created from your inbox. Open a pitch email and choose "Analyse as deal".'
          }
          action={{
            label: q || stage ? 'Clear filters' : 'Go to Inbox',
            href: q || stage ? '/deals' : '/inbox',
          }}
        />
      ) : (
        <>
          <ComparePanel deals={deals.map((d) => ({ id: d.id, company_name: d.company_name }))} />

          <DealsTable rows={sortRows(rows, sort, direction)} sort={sort} direction={direction} />
        </>
      )}
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
