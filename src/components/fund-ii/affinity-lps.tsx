import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { isFundIiField } from '@/lib/crm/stage-map';
import { FUND_II_TABS } from '@/lib/records-tabs';
import { isCrmNotSetUp } from '@/lib/services/crm';
import { listsFor } from '@/lib/services/crm-destinations';
import { lpStageCounts, type LpChipKey } from '@/lib/services/crm-pages';
import { AffinityEntries } from '@/components/crm/affinity-entries';
import { LinkChips, pageHref } from '@/components/crm/link-chips';

const PATH = FUND_II_TABS.path;
const DEFAULT_TAB = FUND_II_TABS.defaultKey;

export type LpSource = 'mail' | 'affinity';

const LP_CHIP_LABEL: Record<LpChipKey, string> = {
  target: 'Target',
  contacted: 'Contacted',
  meeting: 'Meeting',
  materials: 'Materials sent',
  soft_commit: 'Soft commit',
  committed: 'Committed',
  passed: 'Passed',
  other: 'Other stages',
};

/** Columns an LP row shows first: how likely, who they are with, when last in touch. */
const LP_DETAILS =
  /likelihood|probability|conviction|organi[sz]ation|firm|company|type|last contact/i;

/** The params every control in the Affinity LP view keeps. */
const AFFINITY_VIEW = { source: 'affinity' } as const;

/**
 * How many LPs Affinity's LP pipelines hold, for the source switch. Null when
 * the CRM is not set up or cannot be read: the switch then shows no count.
 */
export async function affinityLpCount(auth: AuthContext): Promise<number | null> {
  const lists = await listsFor(getStore(), auth.organizationId, 'lps');
  if (!lists.ok) return null;
  return lists.value.reduce((sum, l) => sum + l.entry_count, 0);
}

/**
 * The LP pipeline's two sources, one click apart: the routine's read of the
 * mailbox (the default, as before) and Affinity's LP pipelines.
 */
export function LpSourceSwitch({
  source,
  mailCount,
  affinityCount,
}: {
  source: LpSource;
  mailCount: number | null;
  affinityCount: number | null;
}) {
  return (
    <LinkChips
      label="LP pipeline source"
      className="mb-4"
      chips={[
        {
          key: 'mail',
          label: 'From mail',
          count: mailCount ?? undefined,
          href: pageHref(PATH, { tab: 'pipeline' }, DEFAULT_TAB),
          active: source === 'mail',
        },
        {
          key: 'affinity',
          label: 'From Affinity',
          count: affinityCount ?? undefined,
          href: pageHref(PATH, { tab: 'pipeline', ...AFFINITY_VIEW }, DEFAULT_TAB),
          active: source === 'affinity',
        },
      ]}
    />
  );
}

/**
 * Fund II → LP pipeline → From Affinity: every row of Affinity's LP pipelines
 * (individuals, institutions, Fund II prospects), grouped by Copilot's LP
 * stages through each list's own labels, with the original label on each
 * row. Fund I's own LPs are not here: their "Committed" is Fund I money, so
 * their lists feed LP lists instead (`lib/crm/destinations.ts`). Stages and
 * likelihood only: the Details cell shows only the columns `isFundIiField`
 * allows, never an amount, the same rule as the rest of Fund II.
 */
export async function AffinityLps({
  auth,
  q,
  stage,
  list,
  page,
}: {
  auth: AuthContext;
  q: string;
  stage: string | null;
  list: string | null;
  page: string | string[] | undefined;
}) {
  const lists = await listsFor(getStore(), auth.organizationId, 'lps');
  const scoped = lists.ok ? lists.value.filter((l) => !list || l.id === list) : [];
  const counted =
    lists.ok && scoped.length
      ? await lpStageCounts(getStore(), auth.organizationId, scoped, { query: q })
      : null;
  const stages = counted?.ok ? counted.value.stages : [];
  const chosen = stages.find((s) => s.key === stage) ?? null;
  const base = { tab: 'pipeline', ...AFFINITY_VIEW, q: q || null, list };
  const keep: Record<string, string> = { ...AFFINITY_VIEW };
  if (chosen) keep.stage = chosen.key;

  const chips =
    stages.length > 0 ? (
      <LinkChips
        label="LP stage"
        chips={[
          {
            key: 'every',
            label: 'Every stage',
            count: counted?.ok ? counted.value.total : undefined,
            href: pageHref(PATH, base, DEFAULT_TAB),
            active: !chosen,
          },
          // A stage nobody is at is left out, unless it is the one chosen.
          ...stages
            .filter((s) => s.count > 0 || s.key === chosen?.key)
            .map((s) => ({
              key: s.key,
              label: LP_CHIP_LABEL[s.key],
              count: s.count,
              href: pageHref(PATH, { ...base, stage: s.key }, DEFAULT_TAB),
              active: chosen?.key === s.key,
            })),
        ]}
      />
    ) : null;

  return (
    <AffinityEntries
      auth={auth}
      destinations="lps"
      path={PATH}
      tab="pipeline"
      defaultTab={DEFAULT_TAB}
      params={{ q, list, page }}
      keep={keep}
      title="LPs in Affinity"
      searchLabel="Search Affinity LPs"
      searchPlaceholder="Search LP name"
      showField={isFundIiField}
      preferFields={LP_DETAILS}
      statusIn={chosen ? chosen.labels : null}
      above={chips}
      emptyTitle="No LP pipeline from Affinity yet"
      emptyDescription="Affinity's LP pipelines (individuals, institutions, Fund II prospects) land here once they are imported on Knowledge."
    />
  );
}

/**
 * Fund II → LP lists: Fund I's LPs, Affinity's newsletter recipient lists and
 * SPV sends, one chip per list with how many people are on it, and the people
 * below. Amounts (commitments, SPV allocations) are never shown.
 */
export async function AffinityLpLists({
  auth,
  q,
  list,
  page,
}: {
  auth: AuthContext;
  q: string;
  list: string | null;
  page: string | string[] | undefined;
}) {
  const lists = await listsFor(getStore(), auth.organizationId, 'lp_lists');
  const summary =
    lists.ok && lists.value.length ? (
      <p className="text-sm text-[var(--fg-muted)]">
        {lists.value.length} {lists.value.length === 1 ? 'list' : 'lists'},{' '}
        {lists.value.reduce((sum, l) => sum + l.entry_count, 0).toLocaleString('en-US')} people in
        all.
      </p>
    ) : null;
  return (
    <AffinityEntries
      auth={auth}
      destinations="lp_lists"
      path={PATH}
      tab="lists"
      defaultTab={DEFAULT_TAB}
      params={{ q, list, page }}
      title="LP lists"
      searchLabel="Search LP lists"
      searchPlaceholder="Search name"
      showField={isFundIiField}
      statusHeader="Status"
      preferFields={/organi[sz]ation|firm|company|email|type/i}
      above={isCrmNotSetUp(lists) ? null : summary}
      emptyTitle="No LP lists from Affinity yet"
      emptyDescription="Fund I's LPs, newsletter recipient lists and SPV lists land here once they are imported on Knowledge."
    />
  );
}
