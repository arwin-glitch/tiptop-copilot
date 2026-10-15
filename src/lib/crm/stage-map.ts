import type { CrmField, DealStage } from '@/lib/types/domain';
import type { LpStage } from '@/lib/services/follow-ups';

/**
 * Reading Affinity's stage labels in Copilot's own terms.
 *
 * Affinity's pipelines are numbered free text ("2. First Call",
 * "7.1 Passed - After Call", "0. Identified / Vetted"), different on every
 * list. The pages that show them next to Copilot's own records need to know
 * which of Copilot's stages each one means, so a deal Affinity has at "5. Due
 * Diligence" sits with Copilot's Diligence deals and an LP at "4. Soft Commit"
 * with the soft commits. The original label is always shown as well: this is
 * a reading for grouping, never a rewrite of either side.
 *
 * Pure and client-safe. Rules are ordered and the first match wins; a label
 * none of them reads is `null` ("Other"), never a guess.
 */

/** A label's words: lowercase, the leading "3." or "8.2" dropped, punctuation folded to spaces. */
export function stageWords(label: string): string {
  const text = label
    .toLowerCase()
    .replace(/^\s*\d+(\.\d+)*\s*[.):-]?\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${text} `;
}

interface StageRule<K extends string> {
  key: K;
  test: RegExp;
}

/**
 * Deal stages, in order. Passing comes first ("Passed - After Call" is a pass,
 * not a meeting; "Closed lost" is not a win), and a partner meeting or term
 * sheet is the IC stage before any meeting reads as a founder meeting.
 */
const DEAL_RULES: readonly StageRule<string>[] = [
  {
    key: 'passed',
    test: / (pass|passed|passing|declined?|lost|dead|rejected|no go|not a fit|turned down|churned) /,
  },
  { key: 'invested', test: / (won|signed|invested|closed|funded|wired|portfolio|portco) / },
  {
    key: 'ic_review',
    test: / (term ?sheets?|ts|ic|investment committee|committee|partner (meeting|review)|decision|approval|negotiat\w*) /,
  },
  { key: 'diligence', test: / (diligence|dd|deep dive|data room|references?) / },
  {
    key: 'founder_meeting',
    test: / (meetings?|calls?|pitch(ed)?|met|demo|intro held|zoom|coffee) /,
  },
  {
    key: 'waiting_for_info',
    test: / (waiting|info|information|follow ?up|materials|requested|pending) /,
  },
  {
    key: 'reviewing',
    test: / (review(ing)?|screen(ing|ed)?|evaluat\w*|qualif\w*|assess\w*|triage) /,
  },
  {
    key: 'monitoring',
    test: / (monitor(ing)?|watch(ing)?|track(ing)?|on hold|hold|later|revisit|nurture|keep warm|future) /,
  },
  {
    key: 'new',
    test: / (new|leads?|sourced|inbound|intro|introduced|prospects?|identified|added|backlog|to contact|outreach|contacted) /,
  },
];

/**
 * Copilot's deal stage for an Affinity pipeline label, or null when the label
 * reads as none of them. With `stages`, only a key the workspace actually has
 * (its thesis may have renamed or dropped some) is returned.
 */
export function affinityDealStageKey(
  label: string | null | undefined,
  stages?: readonly Pick<DealStage, 'key'>[],
): string | null {
  if (!label?.trim()) return null;
  const words = stageWords(label);
  const rule = DEAL_RULES.find((r) => r.test.test(words));
  if (!rule) return null;
  if (stages && !stages.some((s) => s.key === rule.key)) return null;
  return rule.key;
}

/**
 * LP stages, in order. A pass first; "Soft Commit" before "Committed", which
 * it contains; then materials, meetings, first contact and prospects.
 */
const LP_RULES: readonly StageRule<LpStage>[] = [
  {
    key: 'passed',
    test: / (pass|passed|declined?|lost|dead|no|not interested|not a fit|turned down) /,
  },
  {
    key: 'soft_commit',
    test: / (soft (commit|commits|committed|circle|circled)|verbal|indicated|indication) /,
  },
  {
    key: 'committed',
    test: / (committed|commit|signed|closed|funded|wired|subscribed|won|invested|lp) /,
  },
  {
    key: 'materials',
    test: / (materials|data room|deck|ddq|diligence|dd|sent|docs|documents) /,
  },
  { key: 'meeting', test: / (meetings?|met|calls?|pitch(ed)?|held|zoom|coffee) / },
  {
    key: 'contacted',
    test: / (contacted|contact|outreach|reached|emailed|intro|introduced|in touch) /,
  },
  {
    key: 'target',
    test: / (prospects?|prospected|qualified|targets?|identified|leads?|new|sourced|list) /,
  },
];

/** The LP stage an Affinity LP pipeline label means, or null. */
export function affinityLpStage(label: string | null | undefined): LpStage | null {
  if (!label?.trim()) return null;
  const words = stageWords(label);
  return LP_RULES.find((r) => r.test.test(words))?.key ?? null;
}

/**
 * Words that name a column of money. The word boundaries go round the words
 * only: `$` is not a word character, so `\b\$\b` can never match, and the
 * currency signs are tested apart (`MONEY_SIGNS`).
 */
const MONEY_WORDS =
  /\b(amounts?|commit(s|ted|ments?)?|pledge[ds]?|soft ?circle[ds]?|circled|check ?sizes?|cheques?|allocations?|allocated|investments?|invested|capital|valuations?|aum|assets|net ?worth|sizes?|usd|dollars?|revenue|arr|mrr|raised?|proceeds|price|cost|fees?)\b/i;
const MONEY_SIGNS = /[$€£¥]/;

/**
 * A field that holds an amount of money: typed as money, or named like one
 * ("Expected Amount", "Commit ($)", "Soft Circle", "Size ($K)", "AUM"). The
 * Events tab leaves these out. Fund II goes further and shows only what
 * `isFundIiField` allows, since a column of amounts can be called anything
 * and Affinity has no currency type to tell it by.
 */
export function isMoneyField(field: Pick<CrmField, 'type' | 'name'>): boolean {
  if (field.type === 'money') return true;
  return MONEY_SIGNS.test(field.name) || MONEY_WORDS.test(field.name);
}

const LIKELIHOOD_NAME = /\b(likelihood|probability|conviction|confidence|chance)\b/i;

/**
 * The columns an LP row on Fund II may show besides its stage: who the LP is
 * with, what kind of LP, how likely, how they came in, and when they were
 * last in touch.
 */
const FUND_II_NAME =
  /\b(likelihood|probability|conviction|confidence|chance|organi[sz]ations?|firm|company|companies|employer|affiliation|type|category|segment|tier|relationship|last (contact(ed)?|email|meeting|touch\w*|interaction|activity)|next steps?|owners?|source|referr\w*|introduced|intro|location|city|state|region|country|title|role)\b/i;

/**
 * Whether Fund II may show a column. An allowlist rather than a denylist, so
 * "stages only, never an amount" holds for a number column called "Commit" or
 * "Target" as much as for one typed as money: a name that reads as money
 * never shows, a number only when it is the likelihood, and anything else
 * only when `FUND_II_NAME` lists it.
 */
export function isFundIiField(field: Pick<CrmField, 'type' | 'name'>): boolean {
  if (isMoneyField(field)) return false;
  if (LIKELIHOOD_NAME.test(field.name)) return true;
  if (field.type === 'number') return false;
  return FUND_II_NAME.test(field.name);
}

/** A list's likelihood column ("Likelihood", "Probability", "Conviction"), if it has one. */
export function likelihoodField<F extends Pick<CrmField, 'name'>>(fields: readonly F[]): F | null {
  return fields.find((f) => LIKELIHOOD_NAME.test(f.name)) ?? null;
}
