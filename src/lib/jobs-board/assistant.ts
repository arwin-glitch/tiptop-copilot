import {
  JOB_FUNCTION_LABELS,
  type JobFunction,
  type JobRemote,
} from '@/lib/portfolio/job-taxonomy';
import type { JobEmploymentType, JobSeniority } from '@/lib/types/domain';
import { EMPLOYMENT_TYPE_LABELS, SENIORITY_LABELS, placeLine } from './fields';
import {
  EMPTY_FILTERS,
  boardFiltersToSearch,
  companyPath,
  filterBoardJobs,
  homePath,
  jobPath,
  type BoardFilters,
  type PublicCompany,
  type PublicJob,
} from './public';

/**
 * "Ask Arwin" on the public job board, first tier: answers worked out from
 * the published roles themselves, with no AI and no network. The visitor's
 * words are read for a company, a team (the board's own role families,
 * lib/portfolio/job-taxonomy), a place, remote / hybrid / on-site, a level
 * and a type of work; the roles are then picked with the board's own filter
 * (`filterBoardJobs`), so an answer's "See all N" link opens the board on
 * exactly those N roles.
 *
 * It only ever sees what the public board shows (PublicJob / PublicCompany:
 * roles that passed the gate in lib/jobs-board/public.ts), so a draft, a
 * hidden role or anything private cannot surface here. A question about pay
 * policy, visas, interviews or anything else the roles do not say returns
 * null, and the next tier (written answers, then the optional routine) gets
 * it. Pure and client-safe.
 */

export const MAX_ROLE_LINKS = 5;

export const ASSISTANT_NAME = 'Arwin';
export const ASSISTANT_GREETING =
  "Hi, I'm Arwin, TipTop's assistant. Ask me about open roles at our portfolio companies.";
export const ASSISTANT_SUGGESTIONS = ['Remote roles', 'Engineering roles', 'How do I apply?'];
export const IDENTITY_ANSWER = "I'm Arwin, an AI assistant for TipTop's job board.";
export const APPLY_ANSWER = "Each role's Apply button opens the company's own application page.";
export const THANKS_ANSWER = "You're welcome. Ask me anything else about the open roles.";
/** Added to a list of roles when the question asked what they require. */
export const REQUIREMENTS_NOTE = "Each role's page says what it asks for.";
export const NO_ANSWER =
  "I don't have an answer for that one. Try the filters, or ask about a team, place or company.";

export interface AssistantLink {
  label: string;
  /** "Acme Robotics · Austin, TX" for a role, "3 open roles" for a company. */
  detail: string | null;
  href: string;
}

export type InstantKind =
  'identity' | 'greeting' | 'thanks' | 'apply' | 'roles' | 'companies' | 'count';

export interface InstantAnswer {
  kind: InstantKind;
  /** One short sentence, plain text. */
  text: string;
  links: AssistantLink[];
  /** The board (or company list) showing everything the answer counted. */
  seeAll: AssistantLink | null;
}

/** What the board shows, as the assistant reads it. */
export interface AssistantBoard {
  jobs: readonly PublicJob[];
  companies: readonly PublicCompany[];
}

/* ------------------------------------------------------------- reading -- */

/** Accents off, lower case, "&" as "and", everything but letters, digits, + and # a space. */
export function normaliseQuestion(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, giving up (returning max + 1) once it is past `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** How far a typed word may be from a known one: none under 5 letters, one up to 7, two from 8. */
function allowedTypos(word: string): number {
  if (word.length < 5) return 0;
  return word.length >= 8 ? 2 : 1;
}

const FUNCTION_WORDS: Record<Exclude<JobFunction, 'other'>, string[]> = {
  design: [
    'product designer',
    'product design',
    'designer',
    'design',
    'ux',
    'ui',
    'graphic',
    'visual',
  ],
  data: [
    'machine learning',
    'data science',
    'data scientist',
    'data engineer',
    'data',
    'ml',
    'ai',
    'analytics',
    'analyst',
    'scientist',
  ],
  engineering: [
    'full stack',
    'back end',
    'front end',
    'software',
    'engineering',
    'engineer',
    'developer',
    'dev',
    'swe',
    'backend',
    'frontend',
    'fullstack',
    'devops',
    'sre',
    'programmer',
    'eng',
  ],
  product: ['product manager', 'product management', 'product', 'pm'],
  sales: [
    'account executive',
    'business development',
    'go to market',
    'sales',
    'ae',
    'sdr',
    'bdr',
    'gtm',
  ],
  marketing: ['marketing', 'marketer', 'growth', 'content', 'seo', 'brand', 'comms'],
  customer_success: [
    'customer success',
    'customer support',
    'customer service',
    'support',
    'customer',
    'cs',
  ],
  operations: ['supply chain', 'operations', 'operation', 'ops', 'logistics'],
  finance: ['finance', 'financial', 'accounting', 'accountant', 'controller', 'bookkeeping'],
  people: ['human resources', 'people', 'recruiting', 'recruiter', 'hr', 'talent'],
  legal: ['legal', 'counsel', 'lawyer', 'attorney', 'compliance'],
  leadership: ['leadership', 'c level', 'c suite', 'chief'],
};

const REMOTE_WORDS: Record<JobRemote, string[]> = {
  remote: [
    'work from home',
    'working from home',
    'fully remote',
    'remote',
    'remotely',
    'wfh',
    'anywhere',
    'distributed',
  ],
  hybrid: ['hybrid'],
  onsite: ['in the office', 'office based', 'in office', 'in person', 'on site', 'onsite'],
};

const SENIORITY_WORDS: Partial<Record<JobSeniority, string[]>> = {
  entry: [
    'entry level',
    'new grad',
    'new graduate',
    'early career',
    'junior',
    'jr',
    'entry',
    'grad',
  ],
  mid: ['mid level', 'midlevel', 'mid', 'intermediate'],
  senior: ['senior', 'sr', 'snr'],
  staff: ['staff', 'principal'],
  lead: ['tech lead', 'team lead', 'lead'],
  manager: ['management'],
  director: ['director'],
  vp: ['vice president', 'vp'],
  executive: ['executive', 'exec'],
};

const TYPE_WORDS: Partial<Record<JobEmploymentType, string[]>> = {
  full_time: ['full time', 'fulltime', 'permanent'],
  part_time: ['part time', 'parttime'],
  contract: ['contract', 'contractor', 'freelance', 'freelancer'],
  internship: ['internship', 'intern', 'co op', 'coop'],
  temporary: ['temporary', 'temp', 'seasonal'],
};

/** Words that ask about roles in general. */
const ROLE_WORDS = new Set(
  (
    'job jobs role roles opening openings position positions opportunity opportunities vacancy ' +
    'vacancies hiring hire hires career careers listing listings posting postings gig gigs open ' +
    'available work'
  ).split(' '),
);

/** Words that ask about companies. */
const COMPANY_WORDS = new Set('company companies startup startups portfolio'.split(' '));

/**
 * Words the roles cannot answer: pay policy, visas, benefits, the hiring
 * process, the companies' business. These go to the written answers and
 * the routine instead of a list of roles.
 */
const DETAIL_WORDS = new Set(
  (
    'salary salaries pay paid paying compensation comp equity stock options visa visas sponsor ' +
    'sponsors sponsorship benefits benefit insurance pto vacation interview interviews ' +
    'interviewing process deadline deadlines relocation relocate refer referral referrals intro ' +
    'introduction introduce email contact status hear heard response respond resume cv cover ' +
    'culture funding funded raised valuation revenue investors investor founder founders ceo ' +
    'policy policies requirements require required qualifications degree experience reply'
  ).split(' '),
);

/**
 * Detail words a list of roles can still answer once it knows which roles:
 * "entry level roles, no experience needed" lists the entry-level roles,
 * with a note that each role's page says what it asks for.
 */
const REQUIREMENT_WORDS = new Set(
  'requirements requirement require required requires qualifications qualification degree experience'.split(
    ' ',
  ),
);

/** Filler: words a question is built from that say nothing about which roles. */
const FILLER = new Set(
  (
    'a an the and or but if then so to of in on at by for from with about into over as is are ' +
    'was were be been being am do does did done have has had i me my we us our you your he she ' +
    'they them their it its this that these those there here what which who whom whose whos ' +
    'when where why how can could would should will may might must please hi hello hey thanks ' +
    'thank just also any some all each more most very really much many get got go going let ' +
    'like want looking look find show list see tell know need im ive id dont not no yes ok okay ' +
    'one new now currently current right today still team teams type types kind kinds level ' +
    'levels good great best cool interesting tiptop vc board site page fit apply count number ' +
    'total there theres anything something someone else other others near nearby around based ' +
    'location locations place places city area region country role friendly tech technical ' +
    'technology usa america united states stage early stuff thing things'
  ).split(' '),
);

const THANKS_WORDS = new Set('thanks thank thankyou thx ty cheers'.split(' '));
/** Words a message made only of a hello or a thank-you is built from. */
const GREETINGS = new Set([
  ...'hi hello hey hiya howdy yo good morning afternoon evening you so much'.split(' '),
  ...THANKS_WORDS,
]);

/** Common short forms of places, read before a board's own place names. */
const PLACE_ALIASES: Record<string, string> = {
  nyc: 'new york',
  'new york city': 'new york',
  sf: 'san francisco',
  'bay area': 'san francisco',
  dc: 'washington',
  atx: 'austin',
};

function phraseRe(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A plural "s" is allowed on the last word.
  return new RegExp(`(^| )${escaped}s?(?= |$)`, 'g');
}

/** A question being read: matched phrases are taken out, so each word is used once. */
class Reader {
  text: string;
  constructor(normalised: string) {
    this.text = normalised;
  }
  take(phrase: string): boolean {
    if (!phrase) return false;
    const re = phraseRe(phrase);
    if (!re.test(this.text)) return false;
    this.text = this.text.replace(phraseRe(phrase), '$1').replace(/\s+/g, ' ').trim();
    return true;
  }
  /** A word within typo reach of `known` (single words only), taken out. */
  takeNear(known: string): boolean {
    if (known.includes(' ')) return false;
    const max = allowedTypos(known);
    if (max === 0) return false;
    // Only words the reader does not already know: "stuff" is never "staff".
    const hit = this.words().find(
      (w) => !KNOWN_WORDS.has(w) && allowedTypos(w) > 0 && editDistance(w, known, max) <= max,
    );
    return hit ? this.take(hit) : false;
  }
  words(): string[] {
    return this.text.split(' ').filter(Boolean);
  }
}

/** Every phrase of a map, longest first, as [value, phrase]. */
function phrasesOf<T extends string>(map: Partial<Record<T, string[]>>): [T, string][] {
  const out: [T, string][] = [];
  for (const [value, phrases] of Object.entries(map) as [T, string[]][]) {
    for (const phrase of phrases) out.push([value, phrase]);
  }
  return out.sort((a, b) => b[1].length - a[1].length);
}

const FN_PHRASES = phrasesOf(FUNCTION_WORDS);
const REMOTE_PHRASES = phrasesOf(REMOTE_WORDS);
const SENIORITY_PHRASES = phrasesOf(SENIORITY_WORDS);
const TYPE_PHRASES = phrasesOf(TYPE_WORDS);

/** Every word the reader knows the meaning of, so a company name is never "typo-matched" onto one. */
const KNOWN_WORDS = new Set<string>([
  ...ROLE_WORDS,
  ...COMPANY_WORDS,
  ...DETAIL_WORDS,
  ...FILLER,
  ...[...FN_PHRASES, ...REMOTE_PHRASES, ...SENIORITY_PHRASES, ...TYPE_PHRASES].flatMap(([, p]) =>
    p.split(' '),
  ),
]);

/** The first of a map's values whose phrase the question holds (typos tolerated), taken out. */
function readOne<T extends string>(reader: Reader, phrases: [T, string][]): T | null {
  for (const [value, phrase] of phrases) if (reader.take(phrase)) return value;
  for (const [value, phrase] of phrases) if (reader.takeNear(phrase)) return value;
  return null;
}

const CORPORATE_SUFFIX = /\s+(inc|llc|ltd|corp|corporation|co|company|gmbh|plc)$/;

/** A company's name as typed, without "Inc" and the like. */
function companyName(company: PublicCompany): string {
  return normaliseQuestion(company.name).replace(CORPORATE_SUFFIX, '');
}

/**
 * The company the question names: its full name or board address; its first
 * word alone when no other company shares it and it is not an everyday word
 * ("Acme" for Acme Robotics, never "Data" for Data Works); or that first word
 * with a typo, when only one company is that close.
 */
function readCompany(reader: Reader, companies: readonly PublicCompany[]): PublicCompany | null {
  const heads = new Map<string, number>();
  for (const company of companies) {
    const head = companyName(company).split(' ')[0] ?? '';
    heads.set(head, (heads.get(head) ?? 0) + 1);
  }
  const entries = companies.map((company) => {
    const name = companyName(company);
    const head = name.split(' ')[0] ?? '';
    const distinct = head.length >= 4 && !KNOWN_WORDS.has(head) && heads.get(head) === 1;
    const keys = new Set([normaliseQuestion(company.name), name, company.slug.replace(/-/g, ' ')]);
    return {
      company,
      head: distinct ? head : null,
      keys: [...keys].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length),
    };
  });
  entries.sort((a, b) => b.keys[0]!.length - a.keys[0]!.length);
  for (const { company, keys } of entries) {
    if (keys.some((key) => reader.take(key))) return company;
  }
  for (const { company, head } of entries) if (head && reader.take(head)) return company;
  const near = entries.filter(
    ({ head }) =>
      head &&
      head.length >= 5 &&
      reader
        .words()
        .some(
          (w) =>
            !KNOWN_WORDS.has(w) && editDistance(w, head, allowedTypos(head)) <= allowedTypos(head),
        ),
  );
  if (near.length !== 1) return null;
  const { company, head } = near[0]!;
  const word = reader
    .words()
    .find(
      (w) =>
        !KNOWN_WORDS.has(w) && editDistance(w, head!, allowedTypos(head!)) <= allowedTypos(head!),
    );
  if (word) reader.take(word);
  return company;
}

interface PlaceMatch {
  /** The board's own place values the question means. */
  values: string[];
  /** What the answer calls it: the one value, or the shared city. */
  label: string;
  /** The city's words, for the board's search when more than one value matches. */
  words: string;
}

/** A place the board lists that the question names ("Austin" for "Austin, TX" and "Austin, Texas"). */
function readPlace(reader: Reader, jobs: readonly PublicJob[]): PlaceMatch | null {
  const values = new Map<string, string>();
  for (const job of jobs) {
    for (const place of job.locations) {
      if (/^remote\b/i.test(place)) continue;
      if (!values.has(place.toLowerCase())) values.set(place.toLowerCase(), place);
    }
  }
  if (values.size === 0) return null;
  const cities = new Map<string, { label: string; values: string[] }>();
  for (const value of values.values()) {
    const city = value.split(/[,(\-–]/)[0]!.trim();
    const key = normaliseQuestion(city);
    if (key.length < 3 || KNOWN_WORDS.has(key)) continue;
    const entry = cities.get(key) ?? { label: city, values: [] };
    entry.values.push(value);
    cities.set(key, entry);
  }
  for (const [alias, city] of Object.entries(PLACE_ALIASES)) {
    if (cities.has(city) && reader.take(alias)) return placeMatch(city, cities.get(city)!);
  }
  const keys = [...cities.keys()].sort((a, b) => b.length - a.length);
  for (const key of keys) if (reader.take(key)) return placeMatch(key, cities.get(key)!);
  for (const key of keys) {
    if (key.includes(' ') || key.length < 6) continue;
    if (reader.takeNear(key)) return placeMatch(key, cities.get(key)!);
  }
  return null;
}

function placeMatch(key: string, city: { label: string; values: string[] }): PlaceMatch {
  return {
    values: city.values,
    label: city.values.length === 1 ? city.values[0]! : city.label,
    words: key,
  };
}

export interface ParsedQuestion {
  identity: boolean;
  greeting: boolean;
  /** "Thanks!", "thank you so much": a greeting that is a thank-you. */
  thanks: boolean;
  apply: boolean;
  /** Pay, visas, process and the like: the roles cannot answer it. */
  detail: boolean;
  count: boolean;
  companiesAsked: boolean;
  /** "Hiring", "jobs", "roles": a question about roles at all. */
  rolesAsked: boolean;
  company: PublicCompany | null;
  fn: JobFunction | null;
  remote: JobRemote | null;
  seniority: JobSeniority | null;
  type: JobEmploymentType | null;
  place: PlaceMatch | null;
  /** Leftover words some role's title, team or company holds. */
  keywords: string[];
  /** Leftover words nothing on the board holds. */
  unmatched: string[];
  /** The unmatched words that name a place ("in Tokyo", "at Globex"). */
  unmatchedPlaces: string[];
  /** Only requirement words made it a detail question ("no experience needed"). */
  requirementsOnly: boolean;
}

/**
 * Questions about the assistant itself. Anchored to the subject, so "are
 * you hiring AI engineers?" and "who are you hiring for?" are role
 * questions, not identity ones (parseQuestion also skips identity whenever
 * hiring, roles, a company or a place are asked about).
 */
const IDENTITY_RE = [
  /^(are|r) (you|u) (a |an )?(real )?(bot|robot|human|real person|real|person|ai|machine|chatbot|automated|computer|arwin|man|woman|live person|actual person)\b/,
  /^(who|what) (are|r) (you|u)( exactly| really)?$/,
  /\b(talking|speaking|chatting) (to|with) (a |an )?(bot|robot|human|real person|person|ai|machine|chatbot)\b/,
  /\bis this (a |an )?(bot|robot|human|real person|person|ai|chatbot|machine|automated)\b/,
  /\b(is|was) (arwin|this|it) (a |an )?(bot|robot|human|real|person|ai|automated|chatbot|machine)\b/,
  /\b(who is|whos|what is) arwin\b/,
  /\byour name\b/,
];

/** Asked about the assistant with no other subject: "Automated?", "chatbot". */
const IDENTITY_WORD_RE = /\b(automated|chatbot)\b/;

/** Words that make "are you ..." a question about roles, never about the assistant. */
const HIRING_RE = /\b(hiring|hire|hires|hired|recruiting|roles?|jobs?|openings?|positions?)\b/;

/** A greeting or filler in front of a question: "hey, are you a bot?". */
const LEAD_IN_RE = /^((hi|hello|hey|so|ok|okay|wait|um|hmm|sorry|also|and|but) )+/;

function haystackWords(jobs: readonly PublicJob[]): Set<string> {
  const out = new Set<string>();
  for (const job of jobs) {
    for (const text of [job.title, job.team, job.companyName, ...job.locations]) {
      if (!text) continue;
      for (const w of normaliseQuestion(text).split(' ')) if (w) out.add(w);
    }
  }
  return out;
}

/** The question read into what it asks for. */
export function parseQuestion(question: string, board: AssistantBoard): ParsedQuestion {
  const norm = normaliseQuestion(question);
  const words = norm.split(' ').filter(Boolean);
  const detailWords = words.filter(
    (w) => DETAIL_WORDS.has(w) || DETAIL_WORDS.has(w.replace(/s$/, '')),
  );
  const detail = detailWords.length > 0;
  const requirementsOnly =
    detail &&
    detailWords.every(
      (w) => REQUIREMENT_WORDS.has(w) || REQUIREMENT_WORDS.has(w.replace(/s$/, '')),
    );
  const apply = /\b(apply|applying|application|applications|applied)\b/.test(norm);
  const count = /\b(how many|number of|count of|total)\b/.test(norm);
  const companiesAsked =
    /\b(who is|whos|who s) hiring\b/.test(norm) || words.some((w) => COMPANY_WORDS.has(w));
  const rolesAsked = words.some((w) => ROLE_WORDS.has(w));
  const greeting = words.length > 0 && words.every((w) => GREETINGS.has(w));
  const thanks = greeting && words.some((w) => THANKS_WORDS.has(w));

  const reader = new Reader(norm);
  const company = readCompany(reader, board.companies);
  const place = readPlace(reader, board.jobs);
  // Kinds of work before teams: "product designer" is design, "account
  // executive" sales, and "internship" never a team.
  const type = readOne(reader, TYPE_PHRASES);
  const remote = readOne(reader, REMOTE_PHRASES);
  const fn = readOne(reader, FN_PHRASES);
  const seniority = readOne(reader, SENIORITY_PHRASES);

  const known = haystackWords(board.jobs);
  const keywords: string[] = [];
  const unmatched: string[] = [];
  for (const word of reader.words()) {
    const bare = word.replace(/s$/, '');
    if (
      word.length < 3 ||
      FILLER.has(word) ||
      FILLER.has(bare) ||
      ROLE_WORDS.has(word) ||
      ROLE_WORDS.has(bare) ||
      COMPANY_WORDS.has(word) ||
      COMPANY_WORDS.has(bare) ||
      DETAIL_WORDS.has(word) ||
      GREETINGS.has(word) ||
      /^\d+$/.test(word)
    ) {
      continue;
    }
    if (known.has(word)) keywords.push(word);
    else if (known.has(bare)) keywords.push(bare);
    else unmatched.push(word);
  }
  const identity =
    !HIRING_RE.test(norm) &&
    !company &&
    !place &&
    (IDENTITY_RE.some((re) => re.test(norm.replace(LEAD_IN_RE, ''))) ||
      (IDENTITY_WORD_RE.test(norm) && !rolesAsked && !fn));
  // "Jobs in Tokyo", "roles at Globex": the words right after in, at or near
  // (one more word allowed: "in San Jose"). Never the leftovers of "where do
  // the roles come from", which are question words, not a place.
  const unmatchedPlaces = unmatched.filter((w) =>
    new RegExp(`(^| )(in|at|near)( [a-z0-9+#]+)? ${w.replace(/\+/g, '\\+')}( |$)`).test(norm),
  );
  return {
    identity,
    greeting,
    thanks,
    apply,
    detail,
    count,
    companiesAsked: companiesAsked && !company,
    rolesAsked,
    company,
    fn,
    remote,
    seniority,
    type,
    place,
    keywords,
    unmatched,
    unmatchedPlaces,
    requirementsOnly,
  };
}

/* ------------------------------------------------------------ answering -- */

function rolesWord(n: number): string {
  return n === 1 ? 'role' : 'roles';
}

function fnPhrase(fn: JobFunction): string {
  return fn === 'data' ? 'data & ML' : JOB_FUNCTION_LABELS[fn].toLowerCase();
}

const REMOTE_PHRASE: Record<JobRemote, string> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'on-site',
};

/** "senior remote engineering roles at Acme Robotics in Austin". */
function describe(
  parsed: Pick<ParsedQuestion, 'fn' | 'remote' | 'seniority' | 'type' | 'company' | 'place'>,
  filters: BoardFilters,
  n: number,
  words: readonly string[],
): string {
  const parts: string[] = [];
  if (filters.seniority) parts.push(SENIORITY_LABELS[filters.seniority].toLowerCase());
  if (parsed.remote) parts.push(REMOTE_PHRASE[parsed.remote]);
  if (parsed.fn && parsed.fn !== 'other') parts.push(fnPhrase(parsed.fn));
  if (filters.type) parts.push(EMPLOYMENT_TYPE_LABELS[filters.type].toLowerCase());
  parts.push(rolesWord(n));
  let out = parts.join(' ');
  if (words.length > 0) out += ` matching “${words.join(' ')}”`;
  if (parsed.company) out += ` at ${parsed.company.name}`;
  if (parsed.place) out += ` in ${parsed.place.label}`;
  return out;
}

function roleLink(job: PublicJob, base: string): AssistantLink {
  const place = placeLine(job.locations, job.remote);
  return {
    label: job.title,
    detail: [job.companyName, place].filter(Boolean).join(' · '),
    href: jobPath(base, job),
  };
}

function companyLink(company: { slug: string; name: string }, n: number, base: string) {
  return {
    label: company.name,
    detail: `${n} open ${rolesWord(n)}`,
    href: companyPath(base, company.slug),
  };
}

function boardLink(base: string, filters: BoardFilters, label: string): AssistantLink {
  return { label, detail: null, href: `${homePath(base)}${boardFiltersToSearch(filters)}` };
}

function companiesAnswer(
  jobs: readonly PublicJob[],
  board: AssistantBoard,
  base: string,
  phrase: string | null,
): InstantAnswer {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.companySlug, (counts.get(job.companySlug) ?? 0) + 1);
  const hiring = board.companies
    .filter((c) => (counts.get(c.slug) ?? 0) > 0)
    .sort((a, b) => counts.get(b.slug)! - counts.get(a.slug)! || a.name.localeCompare(b.name));
  if (hiring.length === 0) {
    return {
      kind: 'companies',
      text: phrase
        ? `No company has open ${phrase} right now.`
        : 'No company has open roles on the board right now.',
      links: [],
      seeAll: null,
    };
  }
  const n = hiring.length;
  const what = phrase ? `open ${phrase}` : 'open roles';
  return {
    kind: 'companies',
    text: `${n} ${n === 1 ? 'company has' : 'companies have'} ${what}.`,
    links: hiring
      .slice(0, MAX_ROLE_LINKS)
      .map((c) => companyLink(c, counts.get(c.slug) ?? 0, base)),
    seeAll: phrase ? null : { label: `See all ${n}`, detail: null, href: `${base}/companies` },
  };
}

function isStructured(
  parsed: Pick<ParsedQuestion, 'company' | 'fn' | 'remote' | 'seniority' | 'type' | 'place'>,
): boolean {
  return Boolean(
    parsed.company || parsed.fn || parsed.remote || parsed.seniority || parsed.type || parsed.place,
  );
}

/**
 * Whether the board's answer to a question is only a general one: about
 * roles or applying at all, with no company, team, place, setup, level,
 * type or role words picked out ("What is this job board?"). A strong
 * written answer is the better reply to those, so the chat tries the
 * written answers first for them. Never true for a question about the
 * assistant itself, a greeting, a count or a list of companies.
 */
export function isGeneralQuestion(question: string, board: AssistantBoard): boolean {
  const parsed = parseQuestion(question, board);
  if (parsed.identity || parsed.greeting || parsed.count || parsed.companiesAsked) return false;
  return !isStructured(parsed) && parsed.keywords.length === 0;
}

/**
 * The answer the board's own data gives, or null when it cannot answer (the
 * written answers and then the routine get the question).
 */
export function answerFromBoard(
  question: string,
  board: AssistantBoard,
  base: string,
): InstantAnswer | null {
  const parsed = parseQuestion(question, board);
  if (parsed.identity) return { kind: 'identity', text: IDENTITY_ANSWER, links: [], seeAll: null };
  const structured = isStructured(parsed);
  // What a role requires is on its own page; the list can still be given
  // once the question said which roles ("entry level, no experience needed").
  const requirements = parsed.detail && parsed.requirementsOnly && structured;
  if (parsed.detail && !requirements) return null;
  const filters: BoardFilters = {
    ...EMPTY_FILTERS,
    company: parsed.company?.slug ?? null,
    fn: parsed.fn,
    remote: parsed.remote,
    seniority: parsed.seniority,
    type: parsed.type,
    location: parsed.place && parsed.place.values.length === 1 ? parsed.place.values[0]! : null,
  };
  // Words nothing on the board holds are left out once anything else was
  // understood: "engineering jobs in Tokyo" lists the engineering roles
  // (each shows its place) rather than claiming there are none.
  const searchWords = [
    ...(parsed.place && parsed.place.values.length > 1 ? [parsed.place.words] : []),
    ...parsed.keywords,
  ];
  filters.q = searchWords.join(' ');
  let matches = filterBoardJobs(board.jobs, filters);
  // "Intern" is a kind of work on some boards and a level on others.
  if (matches.length === 0 && filters.type === 'internship') {
    const asLevel = { ...filters, type: null, seniority: 'intern' as const };
    const other = filterBoardJobs(board.jobs, asLevel);
    if (other.length > 0) {
      Object.assign(filters, asLevel);
      matches = other;
    }
  }
  const shownWords = parsed.keywords;

  if (parsed.apply) {
    const links = parsed.company
      ? matches.slice(0, MAX_ROLE_LINKS).map((j) => roleLink(j, base))
      : [];
    return {
      kind: 'apply',
      text: APPLY_ANSWER,
      links,
      seeAll:
        parsed.company && matches.length > MAX_ROLE_LINKS
          ? boardLink(base, filters, `See all ${matches.length}`)
          : null,
    };
  }
  if (parsed.thanks) return { kind: 'thanks', text: THANKS_ANSWER, links: [], seeAll: null };
  if (parsed.greeting)
    return { kind: 'greeting', text: ASSISTANT_GREETING, links: [], seeAll: null };

  if (!structured && parsed.keywords.length === 0) {
    if (parsed.unmatched.length > 0) {
      // "Jobs in Tokyo": a fact about the board only when roles were asked
      // for in a place. Other leftovers ("where do the roles come from") go
      // on to the written answers.
      const places = parsed.unmatchedPlaces;
      if (!parsed.rolesAsked || places.length === 0 || places.length > 3) return null;
      return {
        kind: 'roles',
        text: `I couldn't find open roles that mention “${places.join(' ')}”.`,
        links: [],
        seeAll: boardLink(base, EMPTY_FILTERS, `Browse all ${board.jobs.length}`),
      };
    }
    if (parsed.companiesAsked) return companiesAnswer(board.jobs, board, base, null);
    if (!parsed.rolesAsked && !parsed.count) return null;
    const total = board.jobs.length;
    const companies = new Set(board.jobs.map((j) => j.companySlug)).size;
    return {
      kind: parsed.count ? 'count' : 'roles',
      text:
        total === 0
          ? 'There are no open roles on the board right now.'
          : `There ${total === 1 ? 'is' : 'are'} ${total} open ${rolesWord(total)} at ${companies} ${companies === 1 ? 'company' : 'companies'}.`,
      links: board.jobs.slice(0, MAX_ROLE_LINKS).map((j) => roleLink(j, base)),
      seeAll: total > 0 ? boardLink(base, EMPTY_FILTERS, `See all ${total}`) : null,
    };
  }

  if (parsed.companiesAsked) {
    const phrase = describe({ ...parsed, company: null }, filters, 2, shownWords);
    return companiesAnswer(matches, board, base, phrase);
  }

  const n = matches.length;
  if (n === 0) {
    const onlyCompany =
      parsed.company &&
      !parsed.fn &&
      !parsed.remote &&
      !parsed.seniority &&
      !parsed.type &&
      !parsed.place &&
      shownWords.length === 0;
    return {
      kind: 'roles',
      text: onlyCompany
        ? `${parsed.company!.name} has no open roles on the board right now.`
        : `There are no open ${describe(parsed, filters, 2, shownWords)} right now.`,
      links: [],
      seeAll: boardLink(base, EMPTY_FILTERS, `Browse all ${board.jobs.length}`),
    };
  }
  const phrase = describe(parsed, filters, n, shownWords);
  const onlyCompany =
    parsed.company &&
    !parsed.fn &&
    !parsed.remote &&
    !parsed.seniority &&
    !parsed.type &&
    !parsed.place &&
    shownWords.length === 0;
  const listed =
    onlyCompany && /\bhiring\b/.test(normaliseQuestion(question))
      ? `Yes, ${parsed.company!.name} has ${n} open ${rolesWord(n)}.`
      : `There ${n === 1 ? 'is' : 'are'} ${n} open ${phrase}.`;
  const text = requirements ? `${listed} ${REQUIREMENTS_NOTE}` : listed;
  return {
    kind: parsed.count ? 'count' : 'roles',
    text,
    links: matches.slice(0, MAX_ROLE_LINKS).map((j) => roleLink(j, base)),
    seeAll: boardLink(base, filters, `See all ${n}`),
  };
}

/**
 * A few published roles that look related to a question, for the routine's
 * facts: the roles its company, team, place, setup, level or type pick out
 * (or its words, when nothing else), else the board's newest.
 */
export function relatedJobs(question: string, board: AssistantBoard, max = 8): PublicJob[] {
  const parsed = parseQuestion(question, board);
  const filters: BoardFilters = {
    ...EMPTY_FILTERS,
    company: parsed.company?.slug ?? null,
    fn: parsed.fn,
    remote: parsed.remote,
    seniority: parsed.seniority,
    type: parsed.type,
    location: parsed.place && parsed.place.values.length === 1 ? parsed.place.values[0]! : null,
  };
  const picked = filterBoardJobs(board.jobs, filters);
  if (picked.length > 0 && picked.length < board.jobs.length) return picked.slice(0, max);
  if (parsed.keywords.length > 0) {
    const byWords = filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, q: parsed.keywords[0]! });
    if (byWords.length > 0) return byWords.slice(0, max);
  }
  return board.jobs.slice(0, max);
}
