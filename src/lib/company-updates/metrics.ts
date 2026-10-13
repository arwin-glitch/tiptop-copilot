import { normalizeCompanyName } from '@/lib/util/text';

/**
 * Company-reported numbers read out of a founder's update email: ARR or MRR,
 * cash, runway, whether they are raising, and year-over-year growth. Pure.
 *
 * Nothing here is inferred. A figure is kept only when the text states it as
 * the company's current number. Plan, target and goal figures, prior-period
 * comparisons, future milestones, deal and customer figures, money moving in
 * or out, and other people's numbers are dropped. Every statement in the email
 * is read, not just the first, and when two candidates disagree with nothing
 * to choose between them, neither is kept: a wrong number is worse than a
 * missing one. MRR is never turned into ARR.
 */

export interface MoneyValue {
  amount: number;
  /** "$5.4M", "$611K". */
  display: string;
}

export interface RevenueMetric extends MoneyValue {
  kind: 'ARR' | 'MRR';
  evidence: string;
}

export interface CashMetric extends MoneyValue {
  evidence: string;
}

export interface RunwayMetric {
  /** "14 months", "into Feb 2027", "Default alive". */
  label: string;
  months: number | null;
  evidence: string;
}

export interface TextMetric {
  label: string;
  evidence: string;
}

export interface ReportedMetrics {
  revenue: RevenueMetric | null;
  growth: TextMetric | null;
  cash: CashMetric | null;
  runway: RunwayMetric | null;
  raising: TextMetric | null;
}

export const NO_METRICS: ReportedMetrics = {
  revenue: null,
  growth: null,
  cash: null,
  runway: null,
  raising: null,
};

export function hasAnyMetric(m: ReportedMetrics): boolean {
  return Boolean(m.revenue || m.growth || m.cash || m.runway || m.raising);
}

/* ---------------------------------------------------------------- money */

const UNIT: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

/** "$5.4M" from 5_400_000. Up to two decimals, trailing zeros dropped. */
export function formatMoney(amount: number, currency = '$'): string {
  const abs = Math.abs(amount);
  const [div, unit] =
    abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const value = Number((amount / div).toFixed(2));
  return `${currency}${value}${unit}`;
}

interface MoneyToken extends MoneyValue {
  start: number;
  end: number;
}

const MONEY_RE =
  /([$€£])\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(thousand|million|billion|mm|bn|k|m|b))?(?![\w])/gi;

export function findMoney(text: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const n = Number((m[2] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const amount = n * (m[3] ? (UNIT[m[3].toLowerCase()] ?? 1) : 1);
    out.push({
      amount,
      display: formatMoney(amount, m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/* ------------------------------------------------------------ sentences */

const BULLET_RE = /^(?:[•◦▪●*·–—-]|\d{1,2}[.)])\s+/;
/** "ARR: $5.4M" on its own line starts a new segment even without punctuation. */
const LABEL_LINE_RE = /^[A-Z][\w /&()'’+-]{1,30}:\s/;
const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** Drop quoted replies ("On … wrote:" and "> " lines). Forwarded content is kept. */
function stripQuoted(text: string): string {
  const cut =
    /^On [^\n]{5,200}(?:\n[^\n]{0,120})?wrote:\s*$|^-{2,}\s*Original Message\s*-{2,}/im.exec(text);
  const body = cut ? text.slice(0, cut.index) : text;
  return body
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/**
 * The text as sentences. Hard-wrapped lines are joined back together; a
 * bullet or a "Label: value" line starts a new one.
 */
export function toSentences(text: string): string[] {
  const lines = stripQuoted(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const paragraphs: string[] = [];
  let current = '';
  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current);
      current = '';
      continue;
    }
    const startsNew =
      BULLET_RE.test(line) || LABEL_LINE_RE.test(line) || /[.!?]["”')]?$/.test(current);
    if (current && !startsNew) current += ` ${line}`;
    else {
      if (current) paragraphs.push(current);
      current = line;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs
    .flatMap((p) => p.split(/(?<=[.!?]["”')]?)\s+(?=["“(]?[A-Z$€£+])/))
    .map((s) => s.replace(BULLET_RE, '').trim())
    .filter(Boolean);
}

/* --------------------------------------------------------------- clauses */

/** Where a new clause starts: a comma, semicolon or bracket, or a joining word. */
const CLAUSE_BREAK_RE =
  /[,;(]|\s(?:and|but|while|whereas|although|though|since|after|before|because|so|which|who)\s/gi;
/** The same, but a bracket does not end the clause: "Signed Northwind ($120K ARR)". */
const CLAUSE_BREAK_KEEP_PARENS_RE =
  /[,;]|\s(?:and|but|while|whereas|although|though|since|after|before|because|so|which|who)\s/gi;

/** Index just after the last clause break in `text`, or 0. */
function lastBreak(text: string, re: RegExp = CLAUSE_BREAK_RE): number {
  let at = 0;
  for (const m of text.matchAll(re)) at = (m.index ?? 0) + m[0].length;
  return at;
}

/** Index of the first clause break in `text`, or its length. */
function firstBreak(text: string, re: RegExp = CLAUSE_BREAK_RE): number {
  for (const m of text.matchAll(re)) return m.index ?? text.length;
  return text.length;
}

/** "Cash: …", "Our largest deal to date: …": a short label opening the sentence. */
const COLON_LABEL_RE = /^([^:]{1,40}):\s/;

function colonLabel(sentence: string, at: number): { text: string; end: number } | null {
  const m = COLON_LABEL_RE.exec(sentence);
  if (!m || at < m[0].length) return null;
  return { text: m[1] ?? '', end: m[0].length };
}

/* ------------------------------------------------------- revenue & cash */

type Metric = 'arr' | 'mrr' | 'cash' | 'other';
/** How a figure is tied to its metric: the label before it ("ARR: $X") or the noun after it ("$X ARR"). */
type Strength = 'label' | 'trailing';

const AFTER_ARR =
  /^\s*\+?\s*(?:of\s+|in\s+)?(?:total\s+|current\s+)?(?:ARR|annual(?:ized)? recurring revenue)\b/i;
const AFTER_MRR =
  /^\s*\+?\s*(?:of\s+|in\s+)?(?:total\s+|current\s+)?(?:MRR|monthly recurring revenue)\b/i;
const AFTER_CASH =
  /^\s*(?:of\s+|in\s+)?(?:cash(?![- ]?(?:burn|flow|positive|generat))|the bank\b|bank\b)/i;
const AFTER_OTHER =
  /^\s*(?:\/\s*(?:mo|month|yr|year)\b|per\s+(?:month|year)\b|a\s+month\b|(?:of\s+|in\s+|on\s+)?(?:new\s+|net\s+|total\s+|gross\s+)?(?:revenue|sales|bookings|billings|pipeline|GMV|TPV|raised|round|raise|seed|pre-seed|series|bridge|SAFE|valuation|post|pre|cap|burn|contracts?|deals?|ACV|TCV|LTV|CAC|EBITDA|profit|loss|grant|loan|debt|budget|market|TAM|SAM|funding|investment|checks?|commitments?|committed|soft[- ]circled|from|receivables?|payables?|deposits?|marketing|payroll|salar(?:y|ies)|rent|fees|costs?|expenses|opex|capex|inventory|spend)\b)/i;
const KEYWORD_RE =
  /\b(annual(?:ized)? recurring revenue|monthly recurring revenue|ARR|MRR|cash[- ]burn|cash[- ]flow|net burn|gross burn|burn(?: rate)?|cash on hand|cash balance|cash position|cash reserves?|cash|in the bank|bank balance|bank|revenue|sales|bookings|billings|pipeline|GMV|TPV|raised|raising|raise|round|seed|series [a-e]|pre-seed|bridge|SAFE|valuation|TAM|SAM|market|customers?|contracts?|ACV|TCV|LTV|CAC|EBITDA|profit|net income|loss|payroll|opex|spend|budget|grant|loan|debt|price|pricing|receivables?|deposits?)\b/gi;

function keywordMetric(keyword: string): Metric {
  const k = keyword.toLowerCase();
  if (k === 'arr' || k.startsWith('annual')) return 'arr';
  if (k === 'mrr' || k.startsWith('monthly recurring')) return 'mrr';
  if (
    /^(?:cash on hand|cash balance|cash position|cash reserves?|cash|in the bank|bank balance|bank)$/.test(
      k,
    )
  )
    return 'cash';
  return 'other';
}

function lastKeyword(text: string): { metric: Metric; end: number } | null {
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(KEYWORD_RE)) last = m;
  if (!last) return null;
  return { metric: keywordMetric(last[1] ?? ''), end: (last.index ?? 0) + last[0].length };
}

/** Words that may sit between a label and its figure: "ARR ended Q3 at", "Cash: we have". */
const LINK_WORDS = new Set([
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'now',
  'currently',
  'still',
  'stands',
  'stood',
  'sits',
  'sat',
  'sitting',
  'of',
  'at',
  'to',
  'in',
  'on',
  'for',
  'as',
  'from',
  'the',
  'our',
  'its',
  'it',
  "it's",
  'it’s',
  'this',
  'total',
  'totals',
  'totaled',
  'totalled',
  'current',
  'ending',
  'reached',
  'hit',
  'hits',
  'crossed',
  'passed',
  'surpassed',
  'topped',
  'ended',
  'closed',
  'finished',
  'came',
  'comes',
  'landed',
  'grew',
  'grown',
  'growing',
  'increased',
  'expanded',
  'rose',
  'jumped',
  'climbed',
  'went',
  'up',
  'down',
  'dropped',
  'fell',
  'declined',
  'approximately',
  'approx',
  'about',
  'around',
  'roughly',
  'just',
  'over',
  'under',
  'nearly',
  'almost',
  'above',
  'below',
  'end',
  'month',
  'quarter',
  'year',
  'half',
  'period',
  'mo',
  'yr',
  'qoq',
  'mom',
  'yoy',
  'wow',
  'ytd',
  'fy',
  'we',
  "we've",
  'we’ve',
  "we're",
  'we’re',
  'have',
  'has',
  'had',
  'hold',
  'holds',
  'holding',
  'with',
  'remaining',
  'left',
]);
const MONTH_WORD_RE = new RegExp(`^(?:${MONTHS})\\.?$`, 'i');
const PERIOD_WORD_RE = /^(?:q[1-4]|h[12]|fy\d{2,4}|20\d{2}|['’]\d{2})$/i;
const NUMBER_WORD_RE = /^(?:[+-]?\d+(?:\.\d+)?\s?(?:%|x)|\d{1,2}(?:st|nd|rd|th)?)$/i;

/** Only linking words between a label and its figure: no verbs, nouns or clause breaks. */
function linkOnly(text: string): boolean {
  const t = text.replace(/\bapprox\./gi, 'approx').trim();
  if (!t) return true;
  if (t.length > 40) return false;
  // A short aside right after the label: "ARR (Sep 30): $1.2M".
  const body = t.replace(/^\([^()$€£]{0,24}\)/, ' ');
  const parts =
    body.match(
      /[A-Za-z][A-Za-z0-9]*(?:['’][a-z]+)?|['’]\d{2}|[+-]?\d+(?:\.\d+)?\s?(?:%|x)(?![a-z])|\d+(?:st|nd|rd|th)?|\S/gi,
    ) ?? [];
  let words = 0;
  for (const p of parts) {
    if (/^[:=~≈–—+-]$/.test(p)) continue;
    words += 1;
    if (words > 8) return false;
    const w = p.toLowerCase();
    if (LINK_WORDS.has(w) || MONTH_WORD_RE.test(w) || PERIOD_WORD_RE.test(w)) continue;
    if (NUMBER_WORD_RE.test(w)) continue;
    return false;
  }
  return true;
}

/** What may sit between two figures of one list: "$185K in Q2 and $450K", "$1.2M in Q3, $650K". */
const LIST_GAP_RE = new RegExp(
  String.raw`^\s*(?:(?:in|for|at|as of|during|by)\s+(?:the\s+)?(?:end of\s+)?(?:Q[1-4]|H[12]|FY\s?['’]?\d{2,4}|(?:${MONTHS})\.?|20\d{2})(?:\s*['’]\s?\d{2}|\s+20\d{2})?\s*)?(?:,\s*and|,|and|vs\.?|versus|then)\s*$`,
  'i',
);
/** "ARR: $1.2M → $1.5M", "grew from $185K to $450K": the later figure is the current one. */
const ARROW_GAP_RE = /^\s*(?:→|->|-->|⟶|➝|➔|=>|to)\s*$/i;

interface Token extends MoneyToken {
  /** The end of an "old → new" pair; `start` is where the old figure starts. */
  arrow: boolean;
}

function mergeArrows(sentence: string, tokens: readonly MoneyToken[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && ARROW_GAP_RE.test(sentence.slice(prev.end, t.start))) {
      out[out.length - 1] = { ...t, start: prev.start, arrow: true };
    } else out.push({ ...t, arrow: false });
  }
  return out;
}

interface Attributed {
  metric: Metric;
  strength: Strength;
  /** Took the metric from the figure before it in a list, not from its own label. */
  inherited: boolean;
}

/**
 * Which metric a figure belongs to: the noun right after it ("$611K ARR"),
 * the figure it continues a list from, or a label right before it with only
 * linking words between ("ARR ended Q3 at $450K"). A keyword further back
 * proves nothing: in "ARR grew 20% and we spent $400K" the $400K is not ARR.
 */
function attribute(
  sentence: string,
  token: Token,
  prev: { token: Token; attributed: Attributed | null } | null,
): Attributed | null {
  const after = sentence.slice(token.end, token.end + 40);
  if (AFTER_ARR.test(after)) return { metric: 'arr', strength: 'trailing', inherited: false };
  if (AFTER_MRR.test(after)) return { metric: 'mrr', strength: 'trailing', inherited: false };
  if (AFTER_CASH.test(after)) return { metric: 'cash', strength: 'trailing', inherited: false };
  if (AFTER_OTHER.test(after)) return { metric: 'other', strength: 'trailing', inherited: false };
  if (prev?.attributed && LIST_GAP_RE.test(sentence.slice(prev.token.end, token.start))) {
    return { ...prev.attributed, inherited: true };
  }
  const before = sentence.slice(0, token.start);
  const kw = lastKeyword(before);
  if (kw && linkOnly(before.slice(kw.end))) {
    return { metric: kw.metric, strength: 'label', inherited: false };
  }
  // A labelled line: "Cash: we spent $400K this quarter and ended with $2.2M."
  const label = colonLabel(sentence, token.start);
  const labelKw = label ? lastKeyword(label.text) : null;
  if (label && labelKw && labelKw.metric !== 'other') {
    const between = sentence.slice(label.end, token.start);
    const rival = [...between.matchAll(KEYWORD_RE)].some(
      (m) => keywordMetric(m[1] ?? '') !== labelKw.metric,
    );
    if (!rival && linkOnly(between.slice(lastBreak(between)))) {
      return { metric: labelKw.metric, strength: 'label', inherited: false };
    }
  }
  return null;
}

/** Cues before a figure that make it a comparison, a plan, a prior period or someone else's. */
const BEFORE_EXCLUDE = new RegExp(
  [
    String.raw`\bfrom\s*$`,
    String.raw`\b(?:vs\.?|versus|compared (?:to|with)|against|relative to|over|beat|beating|ahead of|behind|below|above)\s+(?:our\s+|the\s+|a\s+|an\s+)?(?:plan\s+of\s+|target\s+of\s+)?$`,
    String.raw`\b(?:plan(?:ned|s)?|target(?:ed|ing|s)?|goals?|budget(?:ed)?|forecast(?:ed|ing|s)?|project(?:ed|ion|ions|ing)|quota|guidance|aim(?:ing|s)?|expect(?:ed|ing|s)?|anticipat\w*|hope|hoping|wants?|needs?|require[sd]?|threshold|benchmark|on track|path to|road to|trajectory|estimate[sd]?|outlook)\b`,
    String.raw`\b(?:to|will|would|should|could|might|can|'ll|’ll)\s+(?:hit|reach|cross|get to|achieve|surpass|exceed|end|close|finish|be at|land at|grow to|double|triple)\b`,
    String.raw`\b(?:last|prior|previous|previously|a year ago|year ago)\b`,
    String.raw`\b(?:new|net new|added|adding|expansion|incremental|booked|signed|churned|lost|grew by|growth of|increase of|increased by|up by|down by)\s*(?:of\s+)?$`,
    String.raw`\b(?:net new|new|added|incremental|expansion|churned|lost|booked)\s+(?:ARR|MRR)\b`,
    String.raw`\b(?:ARR|MRR)\s+(?:added|growth|increase|churn|churned|lost|change)\b`,
    String.raw`\b(?:competitors?|comparables?|comps|peers?|incumbents?|industry|median|average|top quartile|companies with|customers with|companies at|startups with)\b`,
    // "companies have gotten to $20M ARR with their CEO selling": other companies, or a hypothetical.
    String.raw`\b(?:companies|startups|businesses|founders)\b`,
    String.raw`\b(?:gotten|get|gets|getting|got|grow|growing|scale|scaling)\s+(?:us\s+)?to\s*$`,
  ].join('|'),
  'i',
);
/** "$1.2M in Q3 and was $650K": a second figure introduced as what it used to be. */
const PRIOR_LINK = /\b(?:and|but|while|vs\.?|versus)\s+(?:it\s+)?(?:was|were)\s*$/i;
/** Cues right after a figure that make it a plan, a deadline or a prior period. */
const AFTER_EXCLUDE =
  /\b(?:plan|target|goal|budget|forecast|projection|quota|guidance|estimate|outlook)\b|\bby\s+(?:the\s+)?(?:end\s+of|eo[yqm]\b|year[- ]end|q[1-4]\b|20\d\d|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:last|prior|previous)\s+(?:quarter|month|year|period)\b|\ba year ago\b|^\s*(?:of\s+|in\s+)?(?:new|net new|incremental|expansion|added)\s/i;
const MILESTONE_RE = /\bmilestone\b/i;
const ACHIEVED_BEFORE =
  /\b(?:crossed|passed|surpassed|hit|reached|broke|topped|exceeded)\s+(?:the\s+|a\s+|our\s+)?$/i;
const CONDITIONAL_RE =
  /\b(?:after|post|pro[- ]forma|once|if|when|following|assuming)\b[^.]{0,40}\b(?:raise|round|close|closing|funding|financing)\b|\bpost[- ](?:raise|round|money|close)\b/i;
/** "ARR per employee is $180K", "$50K per customer": a ratio, not the company's figure. */
const PER_UNIT_RE =
  /\bper\s+(?:employee|head|headcount|FTE|customer|client|account|seat|user|location|store|rep|AE|logo)\b|\/\s*(?:employee|customer|user|seat|FTE|head)\b/i;

/** Deal, customer and pipeline words: "Signed Northwind ($120K ARR)", "Pipeline ARR is $4M". */
const DEAL_NOUN_RE =
  /\b(?:deals?|contracts?|LOIs?|pipeline|customer|client|logo|account|pilots?|largest|biggest|worth|wins?|won|prospects?|opportunit(?:y|ies)|partners?|partnerships?|purchase orders?|POs?|RFPs?|tenders?|enterprise|segment|bookings?)\b|(?<!\d\s|\ball\s|\bacross\s|\btotal\s)\b(?:customers|clients|logos|accounts)\b/i;
const DEAL_VERB_RE = new RegExp(
  String.raw`\b(?:sign(?:ed|ing)|clos(?:ed|ing)(?!\s+(?:out\s+)?(?:the\s+|our\s+|this\s+|last\s+)?(?:quarter|month|year|period|half|fiscal|books|week|Q[1-4]|H[12]|FY|20\d\d|${MONTHS})\b)|landed|converted|expanded|renewed|upsold|upgraded|awarded)\b`,
  'i',
);
/** The clause is about ARR itself, so "ARR expanded to $1.4M" is not a customer expanding. */
const METRIC_SUBJECT_RE =
  /^\s*(?:(?:our|total|the|company|current)\s+)*(?:ARR|MRR|annual(?:ized)? recurring revenue|monthly recurring revenue)\b/i;
const DEAL_AFTER_RE =
  /^\s*\+?\s*(?:of\s+|in\s+)?(?:ARR|MRR|annual(?:ized)? recurring revenue|monthly recurring revenue)?\s*\)?\s*(?:contracts?|deals?|customers?|clients?|logos?|LOIs?|accounts?|opportunit(?:y|ies)|expansions?|upsells?|renewals?|pilots?|POs?|bookings?|in (?:the\s+|our\s+)?pipeline|pipeline|of pipeline|potential|signed|closed|won|from\s+(?:a|an|one|our|the|its|this|that)\b)/i;
/** "$450K ARR with Globex", "$250K ARR from Acme". Case-sensitive: a capitalised name. */
const DEAL_AFTER_NAME_RE = new RegExp(
  String.raw`^\s*\+?\s*(?:ARR|MRR)?\s*\)?\s*(?:with|from)\s+(?!(?:Q[1-4]|H[12]|FY\d*|ARR|MRR|NRR|NDR|YoY|I|We|Our|The|This|That|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)[A-Z]`,
);
/** After "a $X ARR …", words that do not make it describe something else. */
const A_FIGURE_OK = new Set([
  'run-rate',
  'run',
  'milestone',
  'mark',
  'level',
  'today',
  'now',
  'and',
  'by',
  'in',
  'at',
  'as',
  'with',
  'this',
  'last',
  'for',
  'on',
  'from',
  'or',
  'plus',
  'which',
  'that',
  'so',
  'but',
  'while',
  'yet',
  'already',
]);
const SELF_NOUNS = new Set(['company', 'business', 'startup']);

/** Is this ARR or MRR figure a deal, a customer, a segment or the pipeline rather than the company's own? */
function dealContext(sentence: string, token: Token): boolean {
  const label = colonLabel(sentence, token.start);
  const lead = sentence.slice(label?.end ?? 0, token.start);
  const clause = lead.slice(lastBreak(lead, CLAUSE_BREAK_KEEP_PARENS_RE));
  const context = `${label?.text ?? ''} ${clause}`;
  if (DEAL_NOUN_RE.test(context)) return true;
  if (DEAL_VERB_RE.test(context) && !METRIC_SUBJECT_RE.test(clause)) return true;
  const after = sentence.slice(token.end, token.end + 60);
  if (DEAL_AFTER_RE.test(after) || DEAL_AFTER_NAME_RE.test(after)) return true;
  // "Contoso, a $2M ARR logistics firm": the figure describes something else.
  if (/\b(?:a|an)\s*$/i.test(lead)) {
    const noun = /^\s*(?:ARR|MRR)\s+([a-z][a-z-]*)/i.exec(after)?.[1]?.toLowerCase();
    if (noun && !A_FIGURE_OK.has(noun)) {
      const self = SELF_NOUNS.has(noun) && /\b(?:we|we['’]re|we['’]ve|our)\b/i.test(clause);
      if (!self) return true;
    }
  }
  return false;
}

/** Money moving in or out, or held for someone else: none of it is the cash balance. */
const CASH_FLOW_RE =
  /\b(?:burn(?:ed|ing|t|s)?|spen[dt]|spends|spending|used|using|uses|raised|raising|raise|received|receiving|collected|collecting|collections?|paid|pay(?:s|ing)?|grants?|deployed|invested|investing|moved|processed|returned|distributed|receivables?|generated|generating|cost|costs|kept|keeps?|deposits?|on behalf|customers?|clients?|users?|members?|with us)\b/i;

function cashFlowContext(sentence: string, token: Token, nextStart: number): boolean {
  const label = colonLabel(sentence, token.start);
  const lead = sentence.slice(label?.end ?? 0, token.start);
  const clause = lead.slice(lastBreak(lead, CLAUSE_BREAK_KEEP_PARENS_RE));
  const tail = sentence.slice(token.end, nextStart);
  const after = tail.slice(0, firstBreak(tail));
  return CASH_FLOW_RE.test(`${label?.text ?? ''} ${clause} ${after}`);
}

function perUnit(sentence: string, token: Token, prevEnd: number, nextStart: number): boolean {
  const lead = sentence.slice(prevEnd, token.start);
  const tail = sentence.slice(token.end, nextStart);
  return (
    PER_UNIT_RE.test(lead.slice(lastBreak(lead))) ||
    PER_UNIT_RE.test(tail.slice(0, firstBreak(tail)))
  );
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface Period {
  /** Sortable: year * 12 + month (a quarter counts as its last month). */
  value: number;
  /** The year was written. "Q3" alone is not comparable with "Q3 2025". */
  dated: boolean;
}

/** A period written right after the figure ("$450K in Q3", "$1.2M in September 2026"). */
function periodAfter(after: string): Period | null {
  const q =
    /^\s*(?:ARR\s+|MRR\s+)?(?:in|at|for|during|as of|at the end of|by end of)?\s*(?:the\s+)?Q([1-4])(?:\s*['’]\s?(\d{2})|\s+(20\d{2}))?\b/i.exec(
      after,
    );
  if (q) {
    const year = q[2] ? 2000 + Number(q[2]) : q[3] ? Number(q[3]) : 0;
    return { value: year * 12 + Number(q[1]) * 3, dated: year > 0 };
  }
  const m =
    /^\s*(?:in|at|for|during|as of|at the end of)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d{2}))?\b/i.exec(
      after,
    );
  if (m) {
    const year = m[2] ? Number(m[2]) : 0;
    return {
      value: year * 12 + (MONTH_INDEX[(m[1] ?? '').toLowerCase()] ?? 0),
      dated: year > 0,
    };
  }
  return null;
}

function clauseBefore(sentence: string, from: number, to: number): string {
  const window = sentence.slice(Math.max(from, to - 60), to);
  const cut = Math.max(window.lastIndexOf(','), window.lastIndexOf(';'), window.lastIndexOf('('));
  return cut >= 0 ? window.slice(cut + 1) : window;
}

function clauseAfter(sentence: string, from: number, to: number): string {
  const window = sentence.slice(from, Math.min(to, from + 40));
  const cut = window.search(/[,;(]|\s[-–—]\s/);
  return cut >= 0 ? window.slice(0, cut) : window;
}

function insideParens(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  return (before.match(/\(/g) ?? []).length > (before.match(/\)/g) ?? []).length;
}

interface Candidate extends Token {
  strength: Strength;
  inherited: boolean;
  parenthesized: boolean;
  period: Period | null;
}

interface Found extends MoneyValue {
  strength: Strength;
  period: Period | null;
}

const sameAmount = (list: readonly { amount: number }[]) =>
  list.every((c) => c.amount === list[0]?.amount);

/**
 * The latest figure by its written period. Only when every figure has one, and
 * all of them or none of them carry a year: "Q3" against "Q3 2025" can't be told.
 */
function latestByPeriod<T extends { amount: number; period: Period | null }>(
  list: readonly T[],
): T | null {
  if (!list.every((c) => c.period !== null)) return null;
  const dated = list.filter((c) => c.period?.dated).length;
  if (dated !== 0 && dated !== list.length) return null;
  const latest = Math.max(...list.map((c) => c.period?.value ?? 0));
  const at = list.filter((c) => c.period?.value === latest);
  return sameAmount(at) ? (at[0] ?? null) : null;
}

/** The one current figure for `metric` in this sentence, or null. */
function figureIn(sentence: string, metric: Exclude<Metric, 'other'>): Found | null {
  const raw = findMoney(sentence);
  if (raw.length === 0) return null;
  if (CONDITIONAL_RE.test(sentence) && metric === 'cash') return null;
  // Cells of a table row ("ARR $600K $800K $1.2M", "ARR | $450K | $185K") say
  // nothing about which column is current. HTML tables arrive like this too.
  for (let i = 1; i < raw.length; i++) {
    if (/^[\s|]*$/.test(sentence.slice(raw[i - 1]!.end, raw[i]!.start))) return null;
  }
  const tokens = mergeArrows(sentence, raw);
  const candidates: Candidate[] = [];
  let prev: { token: Token; attributed: Attributed | null } | null = null;
  for (const [i, token] of tokens.entries()) {
    const attributed = attribute(sentence, token, prev);
    const prevEnd = prev?.token.end ?? 0;
    prev = { token, attributed };
    if (!attributed || attributed.metric !== metric) continue;
    if (token.amount < 1000) continue;
    // "+$200K ARR" is a change, not a level.
    if (/(?:^|[\s(])[+−-]$/.test(sentence.slice(Math.max(0, token.start - 2), token.start))) {
      continue;
    }
    const nextStart = tokens[i + 1]?.start ?? sentence.length;
    let before = clauseBefore(sentence, prevEnd, token.start);
    // "grew from $185K to $450K": the "from" belongs to the old figure.
    if (token.arrow) before = before.replace(/\bfrom\s*$/i, '');
    const after = clauseAfter(sentence, token.end, nextStart);
    if (BEFORE_EXCLUDE.test(before)) continue;
    if (i > 0 && PRIOR_LINK.test(before)) continue;
    if (AFTER_EXCLUDE.test(after)) continue;
    if (MILESTONE_RE.test(after) && !ACHIEVED_BEFORE.test(before)) continue;
    if (perUnit(sentence, token, prevEnd, nextStart)) continue;
    if ((metric === 'arr' || metric === 'mrr') && dealContext(sentence, token)) continue;
    if (metric === 'cash' && cashFlowContext(sentence, token, nextStart)) continue;
    candidates.push({
      ...token,
      strength: attributed.strength,
      inherited: attributed.inherited,
      parenthesized: insideParens(sentence, token.start),
      period: periodAfter(sentence.slice(token.end, token.end + 30)),
    });
  }
  if (candidates.length === 0) return null;
  const found = (c: Candidate): Found => ({
    amount: c.amount,
    display: c.display,
    strength: c.strength,
    period: c.period,
  });
  let pool = candidates.some((c) => !c.parenthesized)
    ? candidates.filter((c) => !c.parenthesized)
    : candidates;
  if (sameAmount(pool)) return found(pool[0]!);
  const latest = latestByPeriod(pool);
  if (latest) return found(latest);
  if (/[|\t]/.test(sentence)) return null;
  // Only a figure with its own label: "ARR was $1.2M in Q3 and $650K in Q3 2025".
  pool = pool.filter((c) => !c.inherited);
  return pool.length > 0 && sameAmount(pool) ? found(pool[0]!) : null;
}

/**
 * One figure from every statement in the email. Labelled statements ("ARR:
 * $1.4M", "ARR is $1.4M") beat passing mentions ("$1.4M ARR"); if the ones
 * left disagree and their periods can't settle it, there is no figure.
 */
function settle<T extends Found>(found: readonly T[]): T | null {
  if (found.length === 0) return null;
  const labels = found.filter((f) => f.strength === 'label');
  const pool = labels.length > 0 ? labels : found;
  if (sameAmount(pool)) return pool[0] ?? null;
  return latestByPeriod(pool);
}

const ARR_WORD = /\b(?:ARR|annual(?:ized)? recurring revenue)\b/i;
const MRR_WORD = /\b(?:MRR|monthly recurring revenue)\b/i;
const CASH_WORD = /\b(?:cash(?![- ]?(?:burn|flow|positive|generat))|in the bank|bank balance)\b/i;

function evidence(sentence: string): string {
  const s = sentence.replace(/\s+/g, ' ').trim();
  return s.length > 220 ? `${s.slice(0, 219).trimEnd()}…` : s;
}

/* --------------------------------------------------------------- runway */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty-four': 24,
  'twenty four': 24,
  thirty: 30,
  'thirty-six': 36,
  'thirty six': 36,
};
const NUM_WORD_ALT = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const NUM = String.raw`(\d{1,2}(?:\.\d)?|${NUM_WORD_ALT})`;
const RUNWAY_MONTHS_BEFORE = new RegExp(
  String.raw`\b${NUM}(\+)?(?:\s*(?:-|–|to)\s*(\d{1,2}))?\+?\s*months?(?:\s+of)?\s+(?:cash\s+)?runway\b`,
  'i',
);
const RUNWAY_MONTHS_AFTER = new RegExp(
  String.raw`\brunway\b[^.\d$€£]{0,30}?\b${NUM}(\+)?(?:\s*(?:-|–|to)\s*(\d{1,2}))?\+?\s*months?\b`,
  'i',
);
const RUNWAY_DATE = new RegExp(
  String.raw`\brunway\b(?:\s+[a-z]+){0,3}?\s+(into|through|thru|until|till|to|past|beyond)\s+((?:early|mid|late|the end of|end of)[- ]?\s*)?(?:(${MONTHS})\.?(?:,?\s+((?:20)?\d{2}))?|Q([1-4])\s*['’]?\s*((?:20)?\d{2})|(20\d{2}))\b`,
  'i',
);
const RUNWAY_CONDITIONAL =
  /\b(?:would|could|will|'ll|’ll|if|assuming|pro[- ]forma)\b|\bafter (?:the|this|our|a) (?:raise|round|close|financing)\b|\bpost[- ]?(?:raise|round|money|close)\b|\bwith (?:the|this|a) (?:raise|round|financing|bridge)\b|\bonce (?:we|the)\b/i;
/** Runway someone plans, targets or needs, not runway they have. */
const RUNWAY_PLAN =
  /\b(?:plan(?:s|ned|ning)?|target(?:s|ed|ing)?|goals?|aim(?:s|ed|ing)?|need(?:s|ed)?|want(?:s|ed)?|hope|hoping|expect(?:s|ed|ing)?|intend(?:s|ed)?|on track|path to|road to|towards?|trajectory|forecast(?:s|ed)?|projected)\b/i;
/** A change to runway, not the runway: "extended runway by 6 months", "added 6 months". */
const RUNWAY_CHANGE = new RegExp(
  String.raw`\bextend\w*|\badd(?:ed|s|ing)?\b|\bgain(?:ed|s)?\b|\b(?:more|longer|extra|additional|another)\b|\bby\s+(?:an?\s+(?:extra|additional)\s+)?(?:\d|${NUM_WORD_ALT})`,
  'i',
);
const DEFAULT_ALIVE = /\bdefault[- ]alive\b/i;
const NOT_DEFAULT_ALIVE =
  /\b(?:not|isn['’]t|aren['’]t|no longer|never|become|becoming|get to|reach)\s+(?:yet\s+)?default[- ]alive\b/i;
/** Default alive as a hope or a date: "close to", "to be … by Q2", "next year". */
const DEFAULT_ALIVE_NOT_YET =
  /\b(?:close to|near(?:ly)?|almost|within reach|to be|be|becom(?:e|ing)|get(?:ting)? to|reach(?:ing)?|by (?:Q[1-4]|H[12]|20\d\d|mid|early|late|the end|end of|year[- ]end|next)|next (?:year|quarter)|soon)\b/i;
/** Breaks between the parts of a sentence that can each say something different. */
const RUNWAY_CLAUSE_RE =
  /;|\s[-–—]\s|,\s+(?=(?:and|but|while|so|though|although|whereas|however)\b)|\s(?:and|but|while|whereas)\s+(?=(?:we|i|our|the|that|this|it|they)\b)/gi;

/** The part of the sentence around `at`, between clause breaks. */
function clauseAround(sentence: string, at: number): string {
  let start = 0;
  let end = sentence.length;
  for (const m of sentence.matchAll(RUNWAY_CLAUSE_RE)) {
    const i = m.index ?? 0;
    if (i + m[0].length <= at) start = i + m[0].length;
    else if (i >= at) {
      end = i;
      break;
    }
  }
  return sentence.slice(start, end);
}

const MONTH_SHORT = (m: string) => {
  const key = m.slice(0, 3).toLowerCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
};

function monthsValue(raw: string): number | null {
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return NUMBER_WORDS[raw.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

function runwayIn(sentence: string): RunwayMetric | null {
  if (!/\brunway\b/i.test(sentence) && !DEFAULT_ALIVE.test(sentence)) return null;
  if (RUNWAY_CONDITIONAL.test(sentence)) return null;
  const date = RUNWAY_DATE.exec(sentence);
  if (date && !RUNWAY_PLAN.test(clauseAround(sentence, date.index))) {
    const prep = (date[1] ?? '').toLowerCase().replace('thru', 'through');
    const qualifier = (date[2] ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    let when = '';
    if (date[3]) {
      const yy = date[4] ? (date[4].length === 2 ? `20${date[4]}` : date[4]) : '';
      when = `${MONTH_SHORT(date[3])}${yy ? ` ${yy}` : ''}`;
    } else if (date[5]) {
      const yy = date[6]?.length === 2 ? `20${date[6]}` : (date[6] ?? '');
      when = `Q${date[5]} ${yy}`.trim();
    } else if (date[7]) when = date[7];
    const q = qualifier ? (qualifier.endsWith('-') ? qualifier : `${qualifier} `) : '';
    return { label: `${prep} ${q}${when}`, months: null, evidence: evidence(sentence) };
  }
  const months = RUNWAY_MONTHS_BEFORE.exec(sentence) ?? RUNWAY_MONTHS_AFTER.exec(sentence);
  if (months) {
    const clause = clauseAround(sentence, months.index);
    const near = sentence.slice(Math.max(0, months.index - 25), months.index + months[0].length);
    const low = monthsValue(months[1] ?? '');
    if (
      low !== null &&
      low > 0 &&
      low <= 60 &&
      !RUNWAY_PLAN.test(clause) &&
      !RUNWAY_CHANGE.test(near)
    ) {
      const plus = months[2] ? '+' : '';
      const high = months[3] ? Number(months[3]) : null;
      const label = high && high > low ? `${low}-${high} months` : `${low}${plus} months`;
      return { label, months: low, evidence: evidence(sentence) };
    }
  }
  const alive = DEFAULT_ALIVE.exec(sentence);
  if (alive && !NOT_DEFAULT_ALIVE.test(sentence)) {
    const clause = clauseAround(sentence, alive.index);
    if (!RUNWAY_PLAN.test(clause) && !DEFAULT_ALIVE_NOT_YET.test(clause)) {
      return { label: 'Default alive', months: null, evidence: evidence(sentence) };
    }
  }
  return null;
}

/* -------------------------------------------------------------- raising */

const ROUND_WORD =
  /\b(?:pre-?seed|seed(?:\s+(?:round|extension))?|(?:pre-?)?series\s+[a-e]|round\s+[a-e]|bridge(?:\s+round)?|extension\s+round|fundrais(?:e|ing)|safe\s+round)(?![\w-])/i;
const ROUND_WORD_G = new RegExp(ROUND_WORD.source, 'gi');
/** "seed investors", "Series A lead", "Series A metrics": the round names someone or something else. */
const ROUND_NOT_A_RAISE =
  /^[\s-]*(?:investors?|leads?|backers?|funds?|stage|readiness|board|members?|deck|docs?|investments?|participants?|syndicate|co-?investors?|holders?|shareholders?|preferred|valuation|metrics|milestones?|compan(?:y|ies)|startups?|founders?|days)\b/i;
const RAISE_VERB =
  /\brais(?:e|ing)\s+(?:a|an|our|the|its|another|some)?\s*(?:[$€£]\s?[\d.,]+\s?(?:k|m|mm|b|bn|million)?\s*)?(?:round|seed|pre-?seed|series|bridge|extension|capital|funding|money)\b|\b(?:our|a|the|next|new)\s+raise\b/i;
/** Something is being done about the round: raised, opened, launched, planned, closing. */
const RAISE_ACTION =
  /\b(?:rais(?:e|es|ing)|fundrais\w*|open(?:s|ed|ing)?|launch(?:es|ed|ing)?|kick(?:s|ed|ing)?\s+off|start(?:s|ed|ing)?|clos(?:e|es|ing)|first close|term sheets?|in market|going out|go out|out to market|talks|conversations|process|soft[- ]circled|oversubscribed|commit(?:ted|ments?)|lead investor|led by|prepar\w+|plan(?:s|ned|ning)?|target(?:s|ed|ing)?|pitch(?:es|ing)?|meetings|timeline|soon|upcoming)\b/i;
const RAISE_PAST =
  /\b(?:closed|raised|completed|finished|wrapped|announced|since|surpass\w*|exceeded|close of|closing of|after the close|post[- ]close|associated with|paid|paying|closing update)\b/i;
/** Only a raise that is happening or about to: "we're raising", "preparing to launch a $4.5M seed". */
const RAISE_STRONG_FUTURE =
  /\b(?:raising|preparing|planning|planned|plans?\s+to|launch(?:ing)?|kick(?:ing)?\s+off|start(?:ing)?|in market|going out|talks|will|'ll|’ll|upcoming|next)\b/i;
const RAISE_NEGATION =
  /\b(?:not|no plans? to|don['’]t|do not|aren['’]t|are not|won['’]t|isn['’]t|without)\b[^.]{0,25}\b(?:rais|fundrais|round)/i;
const RAISE_CONDITIONAL = /\b(?:if|whether|unless)\b/i;
/** Someone else's raise: "Our customer Northwind is starting their Series B". */
const RAISE_THIRD_PARTY =
  /\b(?:customers?|clients?|partners?|portfolio compan(?:y|ies)|competitors?|friends?|peers?)\b/i;
const RAISE_THEIRS = /\b(?:their|they|they['’]re|his|her)\b/i;
/** "Bolt is raising a seed round": a named company as the subject. */
const NAMED_SUBJECT =
  /^([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3})\s+(?:is|are|was|were|has|have|had|just|recently|also|will|['’]s|announced|started|kicked|opened|closed|raised|launched|began)\b/;
const NOT_A_NAME = new Set([
  'we',
  'i',
  'our',
  'the',
  'this',
  'that',
  'it',
  'next',
  'in',
  'on',
  'by',
  'at',
  'for',
  'thanks',
  'after',
  'before',
  'since',
  'with',
  'series',
  'seed',
  'pre-seed',
  'bridge',
  'a',
  'an',
  'round',
  'fundraising',
  'fundraise',
  'raising',
  'q1',
  'q2',
  'q3',
  'q4',
  'h1',
  'h2',
]);
const CLAUSE_SPLIT =
  /;|:\s|,\s+(?=(?:with|and|while|but|plus|as|so|which|meanwhile|targeting|aiming|hoping|led|after|before|following|ahead)\b)|\s[-–—]\s/i;
const LEAD_CONNECTOR =
  /^(?:(?:and|but|so|also|with|while|plus|as|meanwhile|finally|lastly|next up|next(?!\s+(?:month|week|quarter|year|spring|summer|fall|autumn|winter)\b))\b[\s,]*)+/i;
const LEAD_SUBJECT =
  /^(?:we|i|the team|the company|our team)(?:\s*['’](?:re|ll|ve|m|d)\b|\s+(?:are|am|will be|will|have|had|were|was))?\s+(?:(?:now|currently|also|actively|officially|finally)\s+)*/i;

function cleanRaising(clause: string): string {
  // Emails in plain text keep their *bold* and _italic_ marks: drop them.
  let s = clause
    .replace(/(^|[\s(])[*_]+(?=\S)|(?<=\S)[*_]+(?=[\s).,;:!?]|$)/g, '$1')
    .trim()
    .replace(LEAD_CONNECTOR, '')
    .trim();
  s = s.replace(LEAD_SUBJECT, '').trim();
  s = s.replace(/^(?:a|an|the)\s+(?=[A-Z$€£]|series|seed|pre|bridge|round)/i, '');
  s = s.replace(/[\s.,;:!]+$/, '');
  if (s.length > 90) s = `${s.slice(0, 89).replace(/\s+\S*$/, '')}…`;
  return s;
}

/** Where the clause first mentions a round as a raise, or -1. */
function raiseMention(clause: string): number {
  for (const m of clause.matchAll(ROUND_WORD_G)) {
    const end = (m.index ?? 0) + m[0].length;
    if (!ROUND_NOT_A_RAISE.test(clause.slice(end))) return m.index ?? 0;
  }
  const verb = RAISE_VERB.exec(clause);
  return verb ? verb.index : -1;
}

const sameCompany = (a: string, b: string) => {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  return Boolean(x && y) && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
};

function raisingIn(sentence: string, company?: string): TextMetric | null {
  if (!ROUND_WORD.test(sentence) && !RAISE_VERB.test(sentence)) return null;
  for (const clause of sentence.split(CLAUSE_SPLIT)) {
    if (!clause) continue;
    const at = raiseMention(clause);
    if (at < 0) continue;
    if (RAISE_NEGATION.test(clause) || RAISE_CONDITIONAL.test(clause)) continue;
    if (!RAISE_ACTION.test(clause)) continue;
    // A raise in progress or ahead, never one that already happened.
    if (!RAISE_STRONG_FUTURE.test(clause)) continue;
    if (
      RAISE_PAST.test(clause) &&
      !/\b(?:raising|preparing|will|'ll|’ll|next|upcoming)\b/i.test(clause)
    ) {
      continue;
    }
    if (RAISE_THIRD_PARTY.test(clause.slice(0, at)) || RAISE_THEIRS.test(clause)) continue;
    const subject = NAMED_SUBJECT.exec(clause.trim().replace(LEAD_CONNECTOR, '').trim())?.[1];
    if (
      subject &&
      !NOT_A_NAME.has(subject.split(/\s+/)[0]!.toLowerCase()) &&
      !(company && sameCompany(subject, company))
    ) {
      continue;
    }
    const label = cleanRaising(clause);
    if (label.length < 6) continue;
    return { label, evidence: evidence(sentence) };
  }
  return null;
}

/* --------------------------------------------------------------- growth */

const YOY_SOURCE = String.raw`(?:\b(up|grew|growing|growth of|increased|increase of|down|declined|decreased|decrease of)\s+(?:by\s+)?)?([+\-−])?\s?(\d{1,4}(?:\.\d+)?)\s?(%|x)\s*(?:YoY|Y\/Y|y-o-y|year[- ]over[- ]year|year[- ]on[- ]year)(?![\w])`;
const YOY_G = new RegExp(YOY_SOURCE, 'gi');
const REVENUE_NOUN =
  /^(?:ARR|MRR|annual(?:ized)? recurring revenue|monthly recurring revenue|recurring revenue|revenues?|sales|bookings|GMV|top[- ]line|billings)$/i;
/** Every metric noun, revenue or not: the one nearest a YoY figure is what grew. */
const METRIC_NOUN_G =
  /\b(?:ARR|MRR|annual(?:ized)? recurring revenue|monthly recurring revenue|recurring revenue|revenues?|sales|bookings|GMV|top[- ]line|billings|headcount|team|staff|employees|hires|people|users|members|customers|clients|logos|locations|stores|sites|accounts|subscribers|downloads|installs|orders|transactions|volume|traffic|visits|sign-?ups|units|shipments|burn|margins?|market|opex|costs?|expenses|spend|churn|retention|NRR|NDR|CAC|LTV|deals|pipeline|EBITDA|profits?|income|loss(?:es)?|cash|runway|valuation|prices?|usage|engagement|DAU|MAU|WAU|productivity)\b/gi;
/** What may open the YoY figure's own clause when it borrows the sentence's subject: "…, +96% YoY". */
const GROWTH_FILLER =
  /^[\s(+]*(?:(?:and|or|plus|with|is|are|was|were|now|currently|up|down|growing|grew|grown|increased|decreased|declined|rose|jumped|growth|of|by|an?|at|which|that['’]s|that\s+is|i\.e\.)[\s,(]*)*$/i;
const GROWTH_FUTURE =
  /\b(?:plan(?:s|ned)?|target(?:s|ing)?|goal|forecast|expect(?:s|ed|ing)?|project(?:ed|ing)?|aim(?:s|ing)?|hope|will|would|could)\b/i;
const GROWTH_PRIOR =
  /\b(?:last|prior|previous)\s+(?:year|quarter|month|period)\b|\ba year ago\b|\bpreviously\b|\bused to\b|\b(?:in|for|during)\s+(?:FY\s?)?20\d\d\b/i;
const GROWTH_THIRD_PARTY =
  /\b(?:customers?|clients?|users?|market|industry|sector|competitors?|peers?|partners?|portfolio)\b/i;

function growthIn(sentence: string): TextMetric | null {
  for (const m of sentence.matchAll(YOY_G)) {
    const at = m.index ?? 0;
    // Never across a semicolon or a dash aside.
    const scope =
      sentence
        .slice(0, at)
        .split(/;|\s[-–—]\s/)
        .pop() ?? '';
    const nouns = [...scope.matchAll(METRIC_NOUN_G)];
    const noun = nouns[nouns.length - 1];
    if (!noun || !REVENUE_NOUN.test(noun[0])) continue;
    const nounEnd = (noun.index ?? 0) + noun[0].length;
    const between = scope.slice(nounEnd);
    const cut = lastBreak(between);
    // "ARR is now $700K, +96% YoY": the figure's own clause has no subject of its own.
    if (cut > 0 ? !GROWTH_FILLER.test(between.slice(cut)) : between.length > 40) continue;
    const context = scope.slice(lastBreak(scope.slice(0, noun.index ?? 0)));
    if (GROWTH_FUTURE.test(context) || GROWTH_PRIOR.test(context)) continue;
    if (GROWTH_THIRD_PARTY.test(context)) continue;
    const value = m[3] ?? '';
    if (m[4] === 'x' || m[4] === 'X')
      return { label: `${value}x YoY`, evidence: evidence(sentence) };
    const down =
      m[2] === '-' || m[2] === '−' || /^(?:down|declined|decreased|decrease of)$/i.test(m[1] ?? '');
    return { label: `${down ? '-' : '+'}${value}% YoY`, evidence: evidence(sentence) };
  }
  return null;
}

/* ----------------------------------------------------------------- all */

export interface ExtractOptions {
  /** The company the update is from, so "Ledgerly is raising its Series A" reads as its own raise. */
  company?: string;
}

/** Every metric the text states. Revenue and cash weigh every statement; the rest take the first good one. */
export function extractMetrics(text: string, options: ExtractOptions = {}): ReportedMetrics {
  const sentences = toSentences(text);
  const arr: (Found & { evidence: string })[] = [];
  const mrr: (Found & { evidence: string })[] = [];
  const cash: (Found & { evidence: string })[] = [];
  let runway: RunwayMetric | null = null;
  let raising: TextMetric | null = null;
  let growth: TextMetric | null = null;
  for (const sentence of sentences) {
    if (ARR_WORD.test(sentence)) {
      const f = figureIn(sentence, 'arr');
      if (f) arr.push({ ...f, evidence: evidence(sentence) });
    }
    if (MRR_WORD.test(sentence)) {
      const f = figureIn(sentence, 'mrr');
      if (f) mrr.push({ ...f, evidence: evidence(sentence) });
    }
    if (CASH_WORD.test(sentence)) {
      const f = figureIn(sentence, 'cash');
      if (f) cash.push({ ...f, evidence: evidence(sentence) });
    }
    runway ??= runwayIn(sentence);
    raising ??= raisingIn(sentence, options.company);
    growth ??= growthIn(sentence);
  }
  const a = settle(arr);
  const m = settle(mrr);
  const c = settle(cash);
  const revenue: RevenueMetric | null = a
    ? { kind: 'ARR', amount: a.amount, display: a.display, evidence: a.evidence }
    : m
      ? { kind: 'MRR', amount: m.amount, display: m.display, evidence: m.evidence }
      : null;
  return {
    revenue,
    growth,
    cash: c ? { amount: c.amount, display: c.display, evidence: c.evidence } : null,
    runway,
    raising,
  };
}

/* ------------------------------------------------------- per company */

export interface UpdateReport {
  messageId: string;
  threadId: string;
  subject: string;
  /** ISO date of the email. */
  date: string;
  metrics: ReportedMetrics;
}

export interface Sourced<T> {
  value: T;
  asOf: string;
  messageId: string;
  threadId: string;
}

export interface MetricPoint {
  date: string;
  amount: number;
}

export interface CompanyNumbers {
  companyId: string;
  name: string;
  revenue: Sourced<RevenueMetric> | null;
  growth: Sourced<TextMetric> | null;
  cash: Sourced<CashMetric> | null;
  runway: Sourced<RunwayMetric> | null;
  raising: Sourced<TextMetric> | null;
  /** Revenue of the latest figure's kind (ARR or MRR), oldest first, one per day. */
  history: MetricPoint[];
  updatesRead: number;
  latestUpdateAt: string | null;
}

const HISTORY_MAX = 12;
const RAISING_FRESH_DAYS = 120;

/** A raise mentioned months before the latest update is history, not news. */
function recentRaising<T extends { asOf: string }>(raising: T | null, newest: string | null) {
  if (!raising || !newest) return null;
  const age = Date.parse(newest) - Date.parse(raising.asOf);
  return age <= RAISING_FRESH_DAYS * 86_400_000 ? raising : null;
}

/** The latest value of each metric across a company's updates, with where it came from. */
export function buildCompanyNumbers(
  company: { id: string; name: string },
  reports: readonly UpdateReport[],
): CompanyNumbers | null {
  const sorted = [...reports].sort((a, b) => b.date.localeCompare(a.date));
  const latest = <K extends keyof ReportedMetrics>(key: K) => {
    for (const r of sorted) {
      const value = r.metrics[key];
      if (value) {
        return {
          value: value as NonNullable<ReportedMetrics[K]>,
          asOf: r.date,
          messageId: r.messageId,
          threadId: r.threadId,
        };
      }
    }
    return null;
  };
  const revenue = latest('revenue');
  const result: CompanyNumbers = {
    companyId: company.id,
    name: company.name,
    revenue,
    growth: latest('growth'),
    cash: latest('cash'),
    runway: latest('runway'),
    raising: recentRaising(latest('raising'), sorted[0]?.date ?? null),
    history: [],
    updatesRead: reports.length,
    latestUpdateAt: sorted[0]?.date ?? null,
  };
  if (!revenue && !result.growth && !result.cash && !result.runway && !result.raising) return null;
  if (revenue) {
    const byDay = new Map<string, MetricPoint>();
    for (const r of [...sorted].reverse()) {
      const rev = r.metrics.revenue;
      if (!rev || rev.kind !== revenue.value.kind) continue;
      byDay.set(r.date.slice(0, 10), { date: r.date, amount: rev.amount });
    }
    const points = [...byDay.values()];
    const kept = withoutOutliers(points);
    result.history = kept.slice(-HISTORY_MAX);
    // The latest figure itself looks like a misread (3x off the rest): show nothing.
    if (!kept.some((p) => p.date === revenue.asOf && p.amount === revenue.value.amount)) {
      result.revenue = null;
      if (!result.growth && !result.cash && !result.runway && !result.raising) return null;
    }
  }
  return result;
}

const OUTLIER_FACTOR = 3;

/**
 * Drop a point that is 3x above or below the median of the others, when there
 * are at least three others to judge by: a series of $3.6M, $3.9M, $4.0M, $20M,
 * $4.1M has one misread ("companies have gotten to $20M ARR"), not a 5x month.
 */
export function withoutOutliers(points: readonly MetricPoint[]): MetricPoint[] {
  if (points.length < 4) return [...points];
  return points.filter((p, i) => {
    const others = points
      .filter((_, j) => j !== i)
      .map((o) => o.amount)
      .sort((a, b) => a - b);
    const mid = others[Math.floor(others.length / 2)]!;
    if (mid <= 0) return true;
    return p.amount <= mid * OUTLIER_FACTOR && p.amount >= mid / OUTLIER_FACTOR;
  });
}

/* ------------------------------------------------------------ sparkline */

export interface Sparkline {
  path: string;
  points: { x: number; y: number }[];
}

/**
 * A trend line drawn to scale: x by date, y from a zero baseline, so a rise
 * from $700K to $780K looks like the 11% it is. Null under two points.
 */
export function sparkline(
  history: readonly MetricPoint[],
  size: { width: number; height: number; pad?: number },
): Sparkline | null {
  if (history.length < 2) return null;
  const pad = size.pad ?? 2;
  const times = history.map((p) => Date.parse(p.date));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const max = Math.max(...history.map((p) => p.amount));
  if (!Number.isFinite(t0) || max <= 0) return null;
  const w = size.width - pad * 2;
  const h = size.height - pad * 2;
  const round = (n: number) => Math.round(n * 10) / 10;
  const points = history.map((p, i) => ({
    x: round(
      pad + (t1 === t0 ? (i / (history.length - 1)) * w : ((times[i]! - t0) / (t1 - t0)) * w),
    ),
    y: round(pad + h - (Math.max(0, p.amount) / max) * h),
  }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  return { path, points };
}
