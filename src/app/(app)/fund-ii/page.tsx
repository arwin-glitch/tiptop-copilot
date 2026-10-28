import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import {
  AffinityLpLists,
  AffinityLps,
  LpSourceSwitch,
  affinityLpCount,
  type LpSource,
} from '@/components/fund-ii/affinity-lps';
import { getStore } from '@/lib/runtime';
import { LpUpdateCard } from '@/components/followups/relay-cards';
import { CampaignList } from '@/components/campaigns/campaign-list';
import { DocSendReaders } from '@/components/fund-ii/docsend-readers';
import { WarmPaths } from '@/components/fund-ii/warm-paths';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import {
  LP_STAGES,
  readFollowUps,
  type FollowUpsState,
  type LpItem,
  type LpStage,
} from '@/lib/services/follow-ups';
import { FUND_II_TABS, resolvePageTab } from '@/lib/records-tabs';
import { PAGE_PARAM, single, tabHref } from '@/lib/util/page-tabs';
import { searchableFirm } from '@/lib/services/warm-paths';
import {
  CAMPAIGNS_MIGRATION_FILE,
  isCampaignsNotSetUp,
  listCampaigns,
  listUnsubscribes,
} from '@/lib/services/campaigns';
import { UnsubscribeList } from '@/components/campaigns/unsubscribe-list';
import { countRecent } from '@/lib/campaigns/status';
import { NotConfigured } from '@/components/ui/not-configured';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ThreadLinks } from '@/components/email/thread-links';
import { EmptyState, ErrorState, Notice, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { StaleHint } from '@/components/feeds/stale-hint';
import { Stat, StatGroup } from '@/components/ui/stat';
import { formatDate, relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Fund II' };
export const dynamic = 'force-dynamic';

const STAGE_LABEL: Record<LpStage, string> = {
  target: 'Target',
  contacted: 'Contacted',
  meeting: 'Meeting',
  materials: 'Materials sent',
  soft_commit: 'Soft commit',
  committed: 'Committed',
  passed: 'Passed',
};

const KIND_LABEL: Record<LpItem['kind'], string> = {
  individual: 'Individual',
  family_office: 'Family office',
  institution: 'Institution',
  fund_of_funds: 'Fund of funds',
  existing_lp: 'Fund I LP',
  other: 'Other',
};

/** A conversation with no touch in three weeks is going quiet. */
const STALE_DAYS = 21;

type Params = Record<string, string | string[] | undefined>;

export default async function FundTwoPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const tab = resolvePageTab(FUND_II_TABS, params);
  const q = single(params.q) ?? '';
  const list = single(params.list) ?? null;
  const page = params[PAGE_PARAM];
  const source: LpSource = single(params.source) === 'affinity' ? 'affinity' : 'mail';
  return (
    <PageShell>
      <PageHeader
        title="Fund II"
        subtitle="Who is reading your DocSend links, every LP conversation for Fund II and where it stands (read from your mail and carried over from Affinity; stages only, no amounts), and the updates you send LPs."
      />
      <PageTabs
        label={FUND_II_TABS.navLabel}
        path={FUND_II_TABS.path}
        tabs={FUND_II_TABS.tabs.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        defaultKey={FUND_II_TABS.defaultKey}
      />
      <Suspense key={tab} fallback={<SkeletonText lines={10} />}>
        {tab === 'pipeline' ? (
          source === 'affinity' ? (
            <AffinityPipelineTab
              q={q}
              stage={single(params.stage) ?? null}
              list={list}
              page={page}
            />
          ) : (
            <PipelineTab />
          )
        ) : tab === 'lists' ? (
          <LpListsTab q={q} list={list} page={page} />
        ) : tab === 'passed' ? (
          <PassedTab />
        ) : tab === 'campaigns' ? (
          <CampaignsTab />
        ) : (
          <DocSendReaders />
        )}
      </Suspense>
    </PageShell>
  );
}

/**
 * The LP pipeline routine's snapshot, grouped by stage. One read (cached) for
 * the Pipeline and Passed tabs alike; neither touches Gmail.
 */
async function loadPipeline() {
  const auth = await requireAuth();
  const now = new Date();
  const { state, snapshot } = await readFollowUps(getStore(), auth.organizationId, { now });
  const pipeline = state === 'ok' ? snapshot.lpPipeline : null;
  const byStage = new Map<LpStage, LpItem[]>(LP_STAGES.map((s) => [s, []]));
  for (const lp of pipeline?.lps ?? []) byStage.get(lp.stage)?.push(lp);
  for (const list of byStage.values()) {
    list.sort((a, b) => (b.last_touch_at ?? '').localeCompare(a.last_touch_at ?? ''));
  }
  const count = (s: LpStage) => byStage.get(s)?.length ?? 0;
  return { tz: auth.profile.timezone, now, state, snapshot, pipeline, byStage, count };
}

function PipelineUnavailable({ state }: { state: FollowUpsState }) {
  return (
    <Notice tone="warn">
      <p>
        {state === 'restricted'
          ? 'This page stays closed until sign-in is limited to TipTop accounts (AUTH_ALLOWED_EMAIL_DOMAINS).'
          : 'The LP pipeline could not be read from Slack right now. Try again in a minute.'}
      </p>
    </Notice>
  );
}

/** Affinity's LP pipelines, behind the same tab as the mail read. */
async function AffinityPipelineTab({
  q,
  stage,
  list,
  page,
}: {
  q: string;
  stage: string | null;
  list: string | null;
  page: string | string[] | undefined;
}) {
  const auth = await requireAuth();
  const [loaded, affinityCount] = await Promise.all([loadPipeline(), affinityLpCount(auth)]);
  const mailCount =
    loaded.state === 'ok'
      ? (loaded.pipeline?.lps.filter((lp) => lp.stage !== 'passed').length ?? 0)
      : null;
  return (
    <>
      <LpSourceSwitch source="affinity" mailCount={mailCount} affinityCount={affinityCount} />
      <AffinityLps auth={auth} q={q} stage={stage} list={list} page={page} />
    </>
  );
}

/** Affinity's newsletter and SPV lists, with member counts and the people on them. */
async function LpListsTab({
  q,
  list,
  page,
}: {
  q: string;
  list: string | null;
  page: string | string[] | undefined;
}) {
  const auth = await requireAuth();
  return <AffinityLpLists auth={auth} q={q} list={list} page={page} />;
}

async function PipelineTab() {
  const auth = await requireAuth();
  const [{ tz, now, state, snapshot, pipeline, byStage, count }, affinityCount] = await Promise.all(
    [loadPipeline(), affinityLpCount(auth)],
  );
  const mailCount =
    state === 'ok' ? (pipeline?.lps.filter((lp) => lp.stage !== 'passed').length ?? 0) : null;
  const sourceSwitch = (
    <LpSourceSwitch source="mail" mailCount={mailCount} affinityCount={affinityCount} />
  );
  if (state !== 'ok') {
    return (
      <>
        {sourceSwitch}
        <PipelineUnavailable state={state} />
      </>
    );
  }

  const lpUpdate = snapshot.lpUpdateDraft ? (
    <LpUpdateCard draft={snapshot.lpUpdateDraft} now={now} />
  ) : null;
  if (!pipeline || pipeline.lps.length === 0) {
    return (
      <>
        {sourceSwitch}
        {lpUpdate}
        <EmptyState
          title="No LP pipeline yet"
          description="The LP pipeline routine posts every weekday morning. Once it has run, every Fund II conversation shows here by stage."
        />
      </>
    );
  }

  const active = pipeline.lps.filter((lp) => lp.stage !== 'passed').length;
  const stale = pipeline.lps.filter(
    (lp) => lp.stage !== 'passed' && lp.stage !== 'committed' && isStale(lp, now),
  ).length;
  const open = LP_STAGES.filter((s) => s !== 'passed');

  return (
    <>
      {sourceSwitch}
      {lpUpdate}
      <p className="mb-4 text-sm text-[var(--fg-muted)]">
        {pipeline.fund} · checked {relativeTime(pipeline.run_at, now)}
        <StaleHint feed="lp-pipeline" checkedAt={pipeline.run_at} now={now} />
      </p>
      <StatGroup className="mb-6" columns={4}>
        <Stat size="sm" label="In conversation" value={active} hint="not passed" />
        <Stat size="sm" label="Meetings or later" value={count('meeting') + count('materials')} />
        <Stat
          size="sm"
          label="Soft commits"
          value={count('soft_commit')}
          hint={`${count('committed')} committed`}
        />
        <Stat
          size="sm"
          label="Going quiet"
          value={stale}
          hint={`no touch in ${STALE_DAYS}+ days`}
        />
      </StatGroup>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {open.map((stage) => (
          <section key={stage} aria-labelledby={`stage-${stage}`}>
            <SectionHeading count={count(stage)} className="mb-2">
              <span id={`stage-${stage}`} className="text-base">
                {STAGE_LABEL[stage]}
              </span>
            </SectionHeading>
            {count(stage) === 0 ? (
              <p className="text-sm text-[var(--fg-subtle)]">Nobody here yet.</p>
            ) : (
              <ul className="space-y-2">
                {byStage.get(stage)?.map((lp) => (
                  <LpCard key={`${lp.who}-${lp.firm ?? ''}`} lp={lp} now={now} tz={tz} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

async function PassedTab() {
  const { state, pipeline, byStage, count } = await loadPipeline();
  if (state !== 'ok') return <PipelineUnavailable state={state} />;
  if (!pipeline || pipeline.lps.length === 0) {
    return (
      <EmptyState
        title="No LP pipeline yet"
        description="The LP pipeline routine posts every weekday morning. Once it has run, anyone who passed shows here."
      />
    );
  }
  if (count('passed') === 0) {
    return (
      <EmptyState
        title="Nobody has passed yet"
        description="An LP who passes moves here from the pipeline, with any note on why."
        action={{
          label: 'See the LP pipeline',
          href: tabHref(FUND_II_TABS.path, 'pipeline', FUND_II_TABS.defaultKey),
        }}
      />
    );
  }
  return (
    <section aria-labelledby="stage-passed">
      <SectionHeading count={count('passed')}>
        <span id="stage-passed">Passed</span>
      </SectionHeading>
      <ul className="space-y-1 text-sm text-[var(--fg-muted)]">
        {byStage.get('passed')?.map((lp) => (
          <li key={`${lp.who}-${lp.firm ?? ''}`}>
            {lp.who}
            {lp.firm ? ` · ${lp.firm}` : ''}
            {lp.note ? ` · ${lp.note}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Tracked bulk email: every campaign with how it landed, and a way to start one. */
async function CampaignsTab() {
  const auth = await requireAuth();
  const result = await listCampaigns(getStore(), auth.organizationId);
  if (isCampaignsNotSetUp(result)) {
    return (
      <NotConfigured
        title="Campaigns are not set up yet"
        description={`The campaign tables have not been created in the database. Run ${CAMPAIGNS_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="The rest of Fund II, and everything else in Kraken, works as before."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title="Campaigns could not be loaded"
        message={result.error.message}
        stillUsable="The rest of Fund II."
      />
    );
  }
  const unsubscribes = await listUnsubscribes(getStore(), auth.organizationId);
  return (
    <div className="space-y-8">
      <CampaignList campaigns={result.value} timezone={auth.profile.timezone} />
      {unsubscribes.ok ? (
        <UnsubscribeList
          recent={countRecent(unsubscribes.value)}
          rows={unsubscribes.value.map((u) => ({
            email: u.email,
            at: u.at,
            source: u.source,
            campaignName: u.campaignName,
          }))}
          timezone={auth.profile.timezone}
        />
      ) : null}
    </div>
  );
}

function isStale(lp: LpItem, now: Date): boolean {
  if (!lp.last_touch_at) return false;
  return now.getTime() - new Date(lp.last_touch_at).getTime() > STALE_DAYS * 86_400_000;
}

function LpCard({ lp, now, tz }: { lp: LpItem; now: Date; tz: string }) {
  const stale = lp.stage !== 'committed' && lp.stage !== 'passed' && isStale(lp, now);
  const firm = searchableFirm(lp.firm);
  const canAskIntro = Boolean(lp.thread_id || firm);
  return (
    <li>
      <Card>
        <CardContent className="pt-3.5 pb-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{lp.who}</p>
              {lp.firm ? <p className="text-xs text-[var(--fg-muted)]">{lp.firm}</p> : null}
            </div>
            {/* The thread with them, in Kraken's Inbox or in Gmail. */}
            <ThreadLinks
              id={lp.thread_id}
              mailbox={DEFAULT_MAILBOX}
              label={`the thread with ${lp.who}`}
              variant="icons"
              className="-mt-1 -mr-1"
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="neutral">{KIND_LABEL[lp.kind]}</Badge>
            {stale ? <Badge tone="warn">Going quiet</Badge> : null}
          </div>
          {lp.next_step ? (
            <p className="mt-1.5 text-xs">
              <span className="text-[var(--fg-subtle)]">Next: </span>
              {lp.next_step}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-[var(--fg-subtle)]">
            {lp.last_touch_at
              ? `Last touch ${formatDate(lp.last_touch_at, tz)}`
              : 'Not contacted yet'}
            {lp.note ? ` · ${lp.note}` : ''}
          </p>
          {canAskIntro ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <WarmPaths thread={lp.thread_id ?? null} firm={firm} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}
