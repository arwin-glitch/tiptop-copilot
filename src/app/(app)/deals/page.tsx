import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listDeals } from '@/lib/services/deals';
import { getActiveThesis } from '@/lib/services/thesis';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Badge, RecommendationBadge } from '@/components/ui/badge';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { DealsFilterBar, ComparePanel } from '@/components/deals/deals-client';
import type { DealAnalysis } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

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

  return (
    <PageShell>
      <PageHeader
        title="Deals"
        subtitle="Everything in the pipeline, with the current recommendation and how much of it rests on real evidence."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <DealsContent stage={stage} q={q} />
      </Suspense>
    </PageShell>
  );
}

async function DealsContent({ stage, q }: { stage: string; q: string }) {
  const auth = await requireAuth();
  const store = getStore();
  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);
  const deals = await listDeals(auth.organizationId, {
    stage: stage || undefined,
    search: q || undefined,
  });

  const analyses = new Map<string, DealAnalysis>();
  for (const deal of deals) {
    const rows = (await store.list(
      'deal_analyses',
      auth.organizationId,
      { eq: { deal_id: deal.id } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
    )) as DealAnalysis[];
    if (rows[0]) analyses.set(deal.id, rows[0]);
  }

  const counts = new Map<string, number>();
  const allDeals = await listDeals(auth.organizationId);
  for (const d of allDeals) counts.set(d.stage, (counts.get(d.stage) ?? 0) + 1);

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

          <ul className="mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {deals.map((deal) => {
              const analysis = analyses.get(deal.id);
              const stageLabel =
                thesis.deal_stages.find((s) => s.key === deal.stage)?.label ?? deal.stage;
              return (
                <li key={deal.id}>
                  <Link
                    href={`/deals/${deal.id}`}
                    className="block px-4 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-serif text-base font-semibold">
                            {deal.company_name}
                          </span>
                          <Badge tone="outline">{stageLabel}</Badge>
                          {deal.vertical ? <Badge tone="neutral">{deal.vertical}</Badge> : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-[var(--fg-muted)]">
                          {deal.product_summary ?? 'No product summary has been extracted yet.'}
                        </p>
                        <p className="mt-1.5 text-xs text-[var(--fg-subtle)]">
                          {[
                            deal.revenue,
                            deal.customer_count,
                            deal.funding_stage,
                            `received ${relativeTime(deal.received_at)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {analysis ? (
                          <>
                            <RecommendationBadge
                              recommendation={
                                analysis.human_override?.recommendation ?? analysis.recommendation
                              }
                            />
                            <p className="tabular mt-1.5 text-[11px] text-[var(--fg-subtle)]">
                              {analysis.quality_score}/100 · {analysis.data_completeness}% complete
                            </p>
                            <p className="tabular text-[11px] text-[var(--fg-subtle)]">
                              {analysis.confidence}% confidence
                            </p>
                          </>
                        ) : (
                          <Badge tone="outline">Not analysed</Badge>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
