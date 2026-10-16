import { CRM_DESTINATION_INFO, type CrmDestination } from '@/lib/crm/destinations';
import type { NetworkContact, PortfolioRequestType } from '@/lib/types/domain';
import { normalizeCompanyName, normalizeDomain } from '@/lib/util/text';

/**
 * Who in the network could help with a portfolio company's request.
 *
 * The same rule as the model's suggestions (`services/portfolio.ts`): only
 * people the data shows, each with the reason the data gives. The network is
 * the contacts imported by hand plus the people carried over from Affinity on
 * the lists that feed Network (investors, service providers, operators,
 * events) and the portfolio founder lists. Nothing here is a model: a
 * candidate fits when the request's kind matches what the data says they are
 * (an investor list, a recruiter's title) and the words of the ask appear in
 * what the data holds about them (expertise, role, company, columns). A request
 * nobody fits gets nobody, never a guess.
 *
 * What counts as evidence, so a list of thousands never names someone at
 * random: a list's name says what its people are (the kind) but never what
 * they know (a word of the ask); a seniority word in a title (Director, VP)
 * makes someone an operator only when no list says what they are (a VC's
 * Managing Director is an investor); and the broad kinds of help (customer
 * intros, advice, go-to-market, product feedback) need a word of the ask in
 * the person's own data, not just a kind that fits and a tie to Nick.
 *
 * Pure; `services/network-helpers.ts` loads the candidates. What a candidate
 * is and the words it holds are worked out once per candidate object and
 * reused across requests (a page holds thousands of candidates).
 */

export type HelperSource = 'imported' | 'affinity';
export type HelperKind = 'person' | 'firm';
export type HelperCategory = 'investors' | 'providers' | 'operators' | 'founders' | 'talent';

export interface HelperList {
  name: string;
  destination: CrmDestination;
}

export interface HelperCandidate {
  /** Stable across loads: `contact:<id>`, `record:<id>` or `entry:<id>`. */
  key: string;
  source: HelperSource;
  kind: HelperKind;
  name: string;
  email: string | null;
  title: string | null;
  company: string | null;
  /** Their Affinity profile. */
  recordId: string | null;
  /** Their imported contact row. */
  contactId: string | null;
  /** The Affinity lists they are on. */
  lists: HelperList[];
  /** A relationship the data states ("Co-investor", an entry's "Warm"). */
  relationship: string | null;
  expertise: string[];
  /** Other words the data holds: list columns, notes. Matched, never shown. */
  details: string[];
}

export interface HelperRequest {
  requestType: PortfolioRequestType | null;
  /** The ask and its summary. */
  text: string;
  /** The company asking: its own people are never suggested to it. */
  company: { name: string; domain: string | null } | null;
}

export interface HelperMatch {
  candidate: HelperCandidate;
  /** Why, in plain words, each from the data. */
  reasons: string[];
  score: number;
  lastContactAt: string | null;
}

/** At most this many people per request. */
export const MAX_HELPERS = 3;

/** What each kind of request needs someone to be. */
const WANTED: Record<PortfolioRequestType, readonly HelperCategory[]> = {
  investor_introduction: ['investors'],
  fundraising: ['investors'],
  candidate_request: ['talent'],
  hiring: ['talent'],
  customer_introduction: ['operators', 'founders'],
  advisor_request: ['providers', 'operators'],
  gtm_strategy: ['operators', 'founders'],
  product_feedback: ['operators', 'founders'],
  board_preparation: ['investors', 'operators'],
  urgent_problem: [],
  general_update: [],
};

const CATEGORY_LABEL: Record<HelperCategory, string> = {
  investors: 'an investor',
  providers: 'a service provider',
  operators: 'an operator',
  founders: 'a portfolio founder',
  talent: 'in recruiting',
};

const DESTINATION_CATEGORY: Partial<Record<CrmDestination, HelperCategory>> = {
  investors: 'investors',
  providers: 'providers',
  operators: 'operators',
  portfolio_people: 'founders',
};

const TEXT_CATEGORY: [HelperCategory, RegExp][] = [
  [
    'investors',
    /\b(?:co-?invest\w*|investors?|venture|vcs?|angels?|limited partners?|seed fund|follow-on|capital|ventures)\b/i,
  ],
  ['talent', /\b(?:recruit\w*|talent|hiring|headhunt\w*|placements?|places founding|staffing)\b/i],
  [
    'providers',
    /\b(?:advis[oe]rs?|consult\w*|lawyers?|legal|attorneys?|accountants?|accounting|cpas?|bankers?|agency|counsel)\b/i,
  ],
  ['operators', /\b(?:operators?|coo|ceo|cto|cfo|cmo|preconstruction|operations)\b/i],
];

/**
 * Seniority words that say someone runs something, not what: an operator
 * only when no list says what they are. A Managing Director or VP on an
 * investor list is an investor.
 */
const SENIORITY = /\b(?:vp|vice president|head of|chief|director|svp|evp|gm|general manager)\b/i;

/** What the data says a candidate is: from their Affinity lists and their own words. */
export function categoriesOf(c: HelperCandidate): Set<HelperCategory> {
  const out = new Set<HelperCategory>();
  for (const list of c.lists) {
    const category = DESTINATION_CATEGORY[list.destination];
    if (category) out.add(category);
  }
  const fromLists = out.size > 0;
  const text = [c.relationship, c.title, ...c.expertise, ...c.lists.map((l) => l.name)]
    .filter(Boolean)
    .join(' · ');
  for (const [category, re] of TEXT_CATEGORY) if (re.test(text)) out.add(category);
  if (!fromLists && SENIORITY.test([c.title, ...c.expertise].filter(Boolean).join(' · '))) {
    out.add('operators');
  }
  return out;
}

/**
 * The kinds of help broad enough that being the right kind of person is not
 * evidence on its own: almost anyone senior could make a customer intro or
 * give advice. These need a word of the ask in the person's own data.
 */
const NEEDS_A_WORD: ReadonlySet<PortfolioRequestType> = new Set<PortfolioRequestType>([
  'customer_introduction',
  'advisor_request',
  'gtm_strategy',
  'product_feedback',
]);

const STOPWORDS = new Set(
  (
    'a an and any anyone are as at be been but by can could do does for from get got have help ' +
    'helping how in into is it its just know knows like looking love make me more most much my ' +
    'need needs of on or our out over people person please really should some someone something ' +
    'than that the their them they this those to up us very want was we were what when where who ' +
    'whom why will with would you your intro intros introduction introductions introduce warm ' +
    'connect connections ask asks request requests great good help helpful team company companies ' +
    'folks also next new month week quarter year update thanks thank via per who whose which'
  ).split(' '),
);

/** A light stem, so "recruiters", "recruiting" and "recruit" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  if (w.length > 5 && (w.endsWith('er') || w.endsWith('or'))) w = w.slice(0, -2);
  return w;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Words that say what kind of help is wanted rather than what it is about.
 * The request type already carries them, so they never count twice: an ask
 * for "investors" must not match every name on a list called "Investors".
 */
const KIND_WORDS = new Set(
  (
    'series seed round raise raising fundraise fundraising lead leads hire hires hiring ' +
    'candidate candidates role roles customer customers client clients pilot pilots referral ' +
    'referrals founder founders operator operators investor investors vc vcs venture ventures ' +
    'capital angel angels advisor advisors adviser advisers recruiter recruiters recruiting ' +
    'recruit talent provider providers partner partners fund funds'
  ).split(' '),
);

/**
 * The kind words by stem too, so "investing" and "invest" (stem "invest", as
 * "investors" is) never match every name on a list of investors.
 */
const KIND_STEMS = new Set([...KIND_WORDS].map(stem));

/** Each word of an ask worth matching, by its stem: no stopwords or kind words, nothing under three letters. */
function askTerms(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of words(text)) {
    if (w.length < 3 || STOPWORDS.has(w) || KIND_WORDS.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (KIND_STEMS.has(s)) continue;
    if (!out.has(s)) out.set(s, w);
  }
  return out;
}

/** The stems of the words of an ask worth matching. */
export function askKeywords(text: string): string[] {
  return [...askTerms(text).keys()];
}

function fieldLabel(c: HelperCandidate, field: string): string {
  switch (field) {
    case 'company':
      return 'company';
    case 'details':
      return c.source === 'imported' ? 'notes' : 'Affinity columns';
    default:
      return field;
  }
}

/** A candidate's kinds and the stems of the words in each of its fields, worked out once. */
interface Prepared {
  categories: Set<HelperCategory>;
  fields: [string, Set<string>][];
}

/**
 * Per candidate object. The loaded candidates are cached for minutes and
 * matched against every open request, so their words are read once rather
 * than once per request. A candidate is not changed after it is matched.
 */
const prepared = new WeakMap<HelperCandidate, Prepared>();

function prepare(c: HelperCandidate): Prepared {
  const hit = prepared.get(c);
  if (hit) return hit;
  // A list's name is not here: it says what its people are (scored as the
  // kind), never what one of them knows.
  const fields: [string, string[]][] = [
    ['expertise', c.expertise],
    ['role', c.title ? [c.title] : []],
    ['company', c.company ? [c.company] : []],
    ['relationship', c.relationship ? [c.relationship] : []],
    ['details', c.details],
  ];
  const out: Prepared = {
    categories: categoriesOf(c),
    fields: fields
      .map(([field, values]): [string, Set<string>] => [
        field,
        new Set(values.flatMap((v) => words(v).map(stem))),
      ])
      .filter(([, stems]) => stems.size > 0),
  };
  prepared.set(c, out);
  return out;
}

/** Where a keyword was found, for the reason line. */
function fieldHits(p: Prepared, keywords: readonly string[]): Map<string, string> {
  const hits = new Map<string, string>();
  if (keywords.length === 0) return hits;
  for (const [field, stems] of p.fields) {
    for (const k of keywords) if (!hits.has(k) && stems.has(k)) hits.set(k, field);
  }
  return hits;
}

/** Whether a candidate belongs to the company asking. */
function isOwnPeople(c: HelperCandidate, company: HelperRequest['company']): boolean {
  if (!company) return false;
  const domain = normalizeDomain(company.domain);
  const host = c.email?.split('@')[1]?.toLowerCase() ?? null;
  if (domain && host && (host === domain || host.endsWith(`.${domain}`))) return true;
  const name = normalizeCompanyName(company.name);
  if (!name) return false;
  if (c.company && normalizeCompanyName(c.company) === name) return true;
  return c.kind === 'firm' && normalizeCompanyName(c.name) === name;
}

const WARM_VALUE = /^(?:close|warm|strong|very warm|friend|good)$/i;

function listReason(c: HelperCandidate, wanted: readonly HelperCategory[]): string | null {
  const list =
    c.lists.find((l) => {
      const category = DESTINATION_CATEGORY[l.destination];
      return category !== undefined && wanted.includes(category);
    }) ?? null;
  if (!list) return null;
  return `On “${list.name}” (${CRM_DESTINATION_INFO[list.destination].label}) in Affinity`;
}

function whoLine(c: HelperCandidate): string | null {
  const parts = [c.title, c.company].filter(Boolean);
  if (c.relationship && c.source === 'imported') parts.unshift(c.relationship);
  return parts.length ? parts.join(', ') : null;
}

const YEAR_MS = 365 * 86_400_000;

/**
 * The people who could help with one request, best first, at most `max`.
 * A candidate needs a score of 3: their kind fits the request (2), each word
 * of the ask found in their own data (1, up to 3; never their list's name),
 * and being someone Nick knows (1): a contact he imported, a "Warm" or
 * "Close" in Affinity, or mail with them in the last year. A kind that fits
 * with no word or tie to back it is not enough, so a list of two thousand
 * investors never names one at random; and for the broad kinds of help
 * (`NEEDS_A_WORD`) a fitting kind and a tie are not enough without a word.
 */
export function suggestHelpers(
  request: HelperRequest,
  candidates: readonly HelperCandidate[],
  options: {
    max?: number;
    now?: Date;
    /** When the fund was last in touch with them, from the mail; null for never. */
    lastContact?: (candidate: HelperCandidate) => string | null;
    /** Already chosen (stored on the request); left out here. */
    exclude?: ReadonlySet<string>;
  } = {},
): HelperMatch[] {
  const wanted = request.requestType ? WANTED[request.requestType] : [];
  const needsAWord = request.requestType !== null && NEEDS_A_WORD.has(request.requestType);
  const terms = askTerms(request.text);
  const keywords = [...terms.keys()];
  // Nothing to match on: no kind of help wanted and no word worth matching.
  if (keywords.length === 0 && (wanted.length === 0 || needsAWord)) return [];
  const now = (options.now ?? new Date()).getTime();
  // Scored first, the reasons written only for the few that are shown: a
  // broad word can match thousands of candidates.
  const scored: {
    candidate: HelperCandidate;
    fits: HelperCategory[];
    hits: Map<string, string>;
    known: 'imported' | 'relationship' | 'mail' | null;
    score: number;
    lastContactAt: string | null;
  }[] = [];
  for (const c of candidates) {
    if (options.exclude?.has(c.key)) continue;
    const p = prepare(c);
    const fits = wanted.filter((w) => p.categories.has(w));
    const hits = fieldHits(p, keywords);
    if (fits.length === 0 && hits.size === 0) continue;
    if (needsAWord && hits.size === 0) continue;
    if (isOwnPeople(c, request.company)) continue;

    let score = (fits.length > 0 ? 2 : 0) + Math.min(hits.size, 3);
    const lastContactAt = options.lastContact?.(c) ?? null;
    const known =
      c.source === 'imported'
        ? 'imported'
        : c.relationship && WARM_VALUE.test(c.relationship.trim())
          ? 'relationship'
          : lastContactAt && now - Date.parse(lastContactAt) <= YEAR_MS
            ? 'mail'
            : null;
    if (known) score += 1;
    if (score < 3) continue;
    scored.push({ candidate: c, fits, hits, known, score, lastContactAt });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? '') ||
      (a.candidate.source === b.candidate.source
        ? 0
        : a.candidate.source === 'imported'
          ? -1
          : 1) ||
      a.candidate.name.localeCompare(b.candidate.name),
  );
  return scored
    .slice(0, options.max ?? MAX_HELPERS)
    .map(({ candidate: c, fits, hits, known, score, lastContactAt }) => {
      const reasons: string[] = [];
      if (fits.length > 0) {
        const who = whoLine(c);
        const onList = listReason(c, fits);
        if (onList) reasons.push(onList);
        else if (who) reasons.push(who);
        else reasons.push(`Listed as ${CATEGORY_LABEL[fits[0]!]}`);
      }
      if (hits.size > 0) {
        const byField = new Map<string, string[]>();
        for (const [k, field] of hits) byField.set(field, [...(byField.get(field) ?? []), k]);
        for (const [field, ks] of byField) {
          const shown = ks.slice(0, 2).map((k) => terms.get(k) ?? k);
          reasons.push(`Matches “${shown.join('”, “')}” in their ${fieldLabel(c, field)}`);
          if (reasons.length >= 2) break;
        }
      }
      if (known === 'imported') reasons.push('In the contacts you imported');
      else if (known === 'relationship') reasons.push(`Relationship: ${c.relationship?.trim()}`);
      return { candidate: c, reasons: [...new Set(reasons)], score, lastContactAt };
    });
}

/** An imported network contact as a candidate. */
export function candidateFromContact(c: NetworkContact): HelperCandidate {
  return {
    key: `contact:${c.id}`,
    source: 'imported',
    kind: 'person',
    name: c.full_name,
    email: c.email?.trim().toLowerCase() || null,
    title: c.title,
    company: c.company,
    recordId: null,
    contactId: c.id,
    lists: [],
    relationship: c.relationship,
    expertise: c.expertise,
    details: [c.notes, c.geography].filter((v): v is string => Boolean(v)),
  };
}

/**
 * One candidate per person: an imported contact and an Affinity person with
 * the same address become one (the imported row leads, with the lists added),
 * and one Affinity person on several lists is one candidate.
 */
export function mergeCandidates(
  imported: readonly HelperCandidate[],
  affinity: readonly HelperCandidate[],
): HelperCandidate[] {
  const out: HelperCandidate[] = [];
  const byEmail = new Map<string, HelperCandidate>();
  const byKey = new Map<string, HelperCandidate>();
  const join = (into: HelperCandidate, from: HelperCandidate) => {
    for (const list of from.lists) {
      if (!into.lists.some((l) => l.name === list.name)) into.lists.push(list);
    }
    into.recordId ??= from.recordId;
    into.title ??= from.title;
    into.company ??= from.company;
    into.relationship ??= from.relationship;
    into.details.push(...from.details);
  };
  for (const c of [...imported, ...affinity]) {
    const copy: HelperCandidate = {
      ...c,
      lists: [...c.lists],
      details: [...c.details],
      expertise: [...c.expertise],
    };
    const same = byKey.get(c.key) ?? (copy.email ? byEmail.get(copy.email) : undefined);
    if (same) {
      join(same, copy);
      continue;
    }
    out.push(copy);
    byKey.set(copy.key, copy);
    if (copy.email) byEmail.set(copy.email, copy);
  }
  return out;
}
