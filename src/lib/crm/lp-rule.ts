import type { CrmField, CrmList, CrmValue } from '@/lib/types/domain';

/**
 * The Fund II rule: LP information is stages only, never amounts.
 *
 * The Fund II page has kept to it since it was built ("Stages only; no
 * amounts"), and the LP pipeline routine's posts carry no amount by schema.
 * The CRM is different: an LP list imported from Affinity can carry a
 * Commitment column. So for any list that looks like an LP list:
 *   - the MCP server drops money fields and amount-like fields wherever an
 *     entry's values are returned (list_entries, get_record, lp_pipeline,
 *     search), will not filter or sort by them, and masks amounts in LP free
 *     text (a next step, a note on the routine's snapshot, a CRM note about
 *     an LP, its title included);
 *   - the Lists page never adds those fields up: no column totals, no
 *     per-stage sums on the board. The column itself stays visible to the
 *     team, as it was before totals existed; a sum is a headline figure (how
 *     much is committed) that the rule keeps off screens.
 *
 * Pure and dependency-free, so the client list components can use it too.
 *
 * Deliberately broad: a list is treated as an LP list when its name says LP,
 * limited partner, investor or Fund II/III. Hiding a check size on a list that
 * only looked like an LP list costs little; showing a commitment does not.
 */

const LP_LIST_RE = /\b(?:LPs?|limited\s+partners?|investors?|fund\s*(?:ii|iii|iv|2|3|4))\b/i;
const AMOUNT_FIELD_RE =
  /amount|commit|allocation|check|ticket|subscri|capital|invest(?:ed|ment)|size|\$|usd|valuation/i;

export function isLpList(list: Pick<CrmList, 'name'>): boolean {
  return LP_LIST_RE.test(list.name);
}

/** Whether a column label reads like an amount ("Commitment", "Check Size", "Amount ($)"). */
export function isAmountLabel(label: string): boolean {
  return AMOUNT_FIELD_RE.test(label);
}

/** Whether a field may be shown for an entry of `list`. */
export function fieldAllowed(
  list: Pick<CrmList, 'name'>,
  field: Pick<CrmField, 'type' | 'name' | 'key'>,
) {
  if (!isLpList(list)) return true;
  if (field.type === 'money') return false;
  return !AMOUNT_FIELD_RE.test(field.name) && !AMOUNT_FIELD_RE.test(field.key);
}

/** The list's fields that may be shown. */
export function visibleFields<F extends Pick<CrmField, 'type' | 'name' | 'key'>>(
  list: Pick<CrmList, 'name'> & { fields: readonly F[] },
): F[] {
  return list.fields.filter((f) => fieldAllowed(list, f));
}

/** An entry's values with the hidden fields removed (and any key no field names). */
export function visibleValues(
  list: Pick<CrmList, 'name' | 'fields'>,
  values: Record<string, CrmValue>,
): Record<string, CrmValue> {
  const allowed = new Set(visibleFields(list).map((f) => f.key));
  const out: Record<string, CrmValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

const AMOUNT_TEXT_RES: RegExp[] = [
  // $2M, $ 250,000, US$1.5 million, $500k
  /(?:US)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|mm|b|bn|million|thousand|billion)\b)?/gi,
  // 250k, 1.5 million, 2mm, 3bn (not a bare "m", which is as often months)
  /\b\d[\d,]*(?:\.\d+)?\s?(?:k|mm|bn|million|thousand|billion)\b/gi,
  // 250,000 USD, 1000000 dollars
  /\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars)\b/gi,
];

/** Free text with any amount replaced by "[amount]". */
export function maskAmounts(text: string): string {
  let out = text;
  for (const re of AMOUNT_TEXT_RES) out = out.replace(re, '[amount]');
  return out;
}
