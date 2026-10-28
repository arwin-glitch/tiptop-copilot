import Link from 'next/link';
import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  countPipeline,
  filterPipeline,
  mergePipeline,
  type PipelineRow,
} from '@/lib/crm/pipeline-merge';
import { statusTone } from '@/lib/crm/view';
import { DEALS_TABS } from '@/lib/records-tabs';
import { CRM_MIGRATION_FILE, isCrmNotSetUp } from '@/lib/services/crm';
import { affinityDealRows } from '@/lib/services/crm-pages';
import { listDeals } from '@/lib/services/deals';
import { getActiveThesis } from '@/lib/services/thesis';
import type { DealStage } from '@/lib/types/domain';
import { PAGE_PARAM, pageNumber, pageWindow } from '@/lib/util/page-tabs';
import { relativeTime } from '@/lib/util/time';
import { LinkChips, pageHref } from '@/components/crm/link-chips';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { Pager } from '@/components/ui/pager';

/** Rows per page of the merged pipeline. */
const PER_PAGE = 50;
const PATH = DEALS_TABS.path;
const TAB = 'pipeline';

/**
 * Deals → Pipeline: Kraken's deals and Affinity's deal lists as one
 * pipeline, a row per company.
 *
 * Grouped by Kraken's stages so it reads like the rest of Deals: a deal
 * Kraken tracks keeps its own stage, and a company only Affinity has sits at
 * the stage its Affinity label reads as (`affinityDealStageKey`), with that
 * label shown beside it. Where both have the company and disagree, the row
 * says so. Read-only: nothing here changes a deal's stage or decision.
 *
 * Opens on the open stages; chips switch stage, the box searches, and the
 * rows come 50 to a page with previous and next.
 */
export async function AffinityPipeline({
  auth,
  q,
  stage,
  page,
}: {
  auth: AuthContext;
  q: string;
  stage: string | null;
  page: string | string[] | undefined;
}) {
  const store = getStore();
  const org = auth.organizationId;
  const [thesis, deals, affinity] = await Promise.all([
    getActiveThesis(store, org, auth.userId),
    listDeals(org),
    affinityDealRows(store, org),
  ]);
  const stages: DealStage[] = [...thesis.deal_stages].sort((a, b) => a.order - b.order);
  const notSetUp = isCrmNotSetUp(affinity);
  const failed = !affinity.ok && !notSetUp ? affinity.error.message : null;
  const rows = mergePipeline(deals, affinity.ok ? affinity.value.entries : [], stages);
  const counts = countPipeline(rows, stages);
  const known = new Set(stages.map((s) => s.key));
  const active =
    stage === 'any' || stage === 'other' || (stage && known.has(stage)) ? stage : 'open';
  const matching = filterPipeline(rows, stages, { stage: active, query: q });
  const paging = pageWindow(pageNumber(page), PER_PAGE, matching.length);
  const shown = matching.slice(paging.offset, paging.offset + PER_PAGE);
  const label = new Map(stages.map((s) => [s.key, s.label]));

  const base = { tab: TAB, q: q || null };
  const chip = (key: string, text: string, count: number) => ({
    key,
    label: text,
    count,
    href: pageHref(PATH, { ...base, stage: key === 'open' ? null : key }, DEALS_TABS.defaultKey),
    active: active === key,
  });
  const chips = [
    chip('open', 'Open', counts.open),
    ...stages
      .filter((s) => (counts.byStage[s.key] ?? 0) > 0)
      .map((s) => chip(s.key, s.label, counts.byStage[s.key] ?? 0)),
    ...(counts.other ? [chip('other', 'Other Affinity stages', counts.other)] : []),
    chip('any', 'Every stage', counts.total),
  ];
  const keep: Record<string, string> = { tab: TAB };
  if (active !== 'open') keep.stage = active;
  const now = new Date();

  return (
    <section aria-label="Pipeline">
      <SectionHeading count={matching.length}>Pipeline</SectionHeading>
      <p className="mb-3 text-sm text-[var(--fg-muted)]">
        {[
          `${counts.total.toLocaleString('en-US')} companies`,
          `${counts.both} in both`,
          `${counts.copilot} only in Kraken`,
          `${counts.affinity} only in Affinity`,
        ].join(' · ')}
        . Read-only: never changes a deal.
        {affinity.ok && affinity.value.truncated ? ' Newest Affinity rows only.' : ''}
      </p>
      {notSetUp ? (
        <NotConfigured
          variant="inline"
          className="mb-3"
          title="Affinity data is not set up yet"
          description={`Showing Kraken's deals only. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor to bring in Affinity's pipeline.`}
        />
      ) : null}
      {failed ? (
        <ErrorState
          className="mb-3"
          title="Affinity's pipeline could not be loaded"
          message={failed}
          stillUsable="Kraken's own deals are listed below."
        />
      ) : null}
      <div className="mb-4 space-y-3">
        <LinkChips label="Pipeline stage" chips={chips} />
        <LiveSearch
          path={PATH}
          keep={keep}
          reset={[PAGE_PARAM]}
          value={q}
          placeholder="Search company or domain"
          label="Search the pipeline"
          className="max-w-sm"
        />
      </div>

      {matching.length === 0 ? (
        <EmptyState
          title={q ? 'No company matches' : 'Nothing at this stage'}
          description={
            q
              ? 'Clear the search, or try part of a name or domain.'
              : 'Pick another stage above, or see every stage.'
          }
          action={{
            label: q ? 'Clear search' : 'See every stage',
            href: q
              ? pageHref(PATH, keep, DEALS_TABS.defaultKey)
              : pageHref(PATH, { tab: TAB, stage: 'any' }, DEALS_TABS.defaultKey),
          }}
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Pipeline</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Company
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Stage
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  In Affinity
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Last activity
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <PipelineRowView key={row.key} row={row} label={label} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label="Pipeline: pages"
        page={paging.page}
        pages={paging.pages}
        total={matching.length}
        shown={shown.length}
        offset={paging.offset}
        hrefFor={(n) =>
          pageHref(
            PATH,
            { ...keep, q: q || null, [PAGE_PARAM]: n > 1 ? String(n) : null },
            DEALS_TABS.defaultKey,
          )
        }
      />
    </section>
  );
}

function rowHref(row: PipelineRow): string {
  if (row.deal) return `/deals/${row.deal.id}`;
  const first = row.affinity[0];
  if (first?.recordId) return `/lists/records/${first.recordId}`;
  return `/lists/${first?.listId ?? ''}?q=${encodeURIComponent(first?.title ?? row.name)}`;
}

function PipelineRowView({
  row,
  label,
  now,
}: {
  row: PipelineRow;
  label: Map<string, string>;
  now: Date;
}) {
  const current = row.affinity[0] ?? null;
  const more = row.affinity.length - 1;
  return (
    <tr className="border-b border-[var(--border)] align-top last:border-b-0">
      <td className="px-4 py-2.5">
        <Link href={rowHref(row)} className="font-medium underline-offset-2 hover:underline">
          {row.name}
        </Link>
        <p className="text-mini flex flex-wrap items-center gap-1.5 text-[var(--fg-subtle)]">
          {row.domain ? <span>{row.domain}</span> : null}
          {row.deal ? <Badge tone="outline">Kraken</Badge> : null}
          {row.affinity.length ? <Badge tone="outline">Affinity</Badge> : null}
        </p>
      </td>
      <td className="px-4 py-2.5">
        {row.stageKey ? (
          <>
            <Badge tone={statusTone(label.get(row.stageKey) ?? row.stageKey)}>
              {label.get(row.stageKey) ?? row.stageKey}
            </Badge>
            {row.stageSource === 'affinity' ? (
              <p className="text-mini mt-0.5 text-[var(--fg-subtle)]">read from Affinity</p>
            ) : null}
          </>
        ) : (
          <span className="text-[var(--fg-subtle)]">Not mapped</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {current ? (
          <>
            <span className="text-[var(--fg)]">{current.status ?? 'No stage'}</span>
            <p className="text-mini mt-0.5 text-[var(--fg-subtle)]">
              {current.listName}
              {more > 0 ? ` · +${more} more` : ''}
            </p>
            {row.differs ? (
              <p className="text-mini mt-0.5 text-[var(--warn)]">Differs from Kraken</p>
            ) : null}
          </>
        ) : (
          <span className="text-[var(--fg-subtle)]">Not in Affinity</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-[var(--fg-muted)]">{relativeTime(row.lastActivity, now)}</td>
    </tr>
  );
}
