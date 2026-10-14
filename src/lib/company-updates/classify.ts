import type { UpdatePost } from '@/lib/updates/types';
import { isFreeEmailDomain, normalizeCompanyName, normalizeDomain } from '@/lib/util/text';

/**
 * Which emails in Nick's mailbox are company or investor updates, and why.
 * Pure: the Gmail reads live in the services, so every rule here is tested
 * with plain strings.
 *
 * The rule that shapes it: a wrong item is worse than a missed one. A subject
 * that reads like an update is not enough on its own, because cold pitches
 * borrow the same words. An update is shown only when the sender's company is
 * in the portfolio, or Nick has emailed that sender (or their company) before.
 */

export const STAFF_DOMAINS = ['tiptop.vc', 'tiptopvc.com'] as const;

/* ---------------------------------------------------------------- senders */

export interface Sender {
  /** Display name, or the address's local part when there is none. */
  name: string;
  address: string;
  domain: string;
}

/** `"Jane Doe" <jane@x.com>` or a bare address. Null when there is no address. */
export function parseSender(header: string): Sender | null {
  const angle = /<\s*(?:mailto:)?([^<>\s]+@[^<>\s]+?)\s*>/i.exec(header);
  const bare = angle ? null : /([^\s<>"',;:]+@[^\s<>"',;:]+)/.exec(header);
  const address = (angle?.[1] ?? bare?.[1] ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1);
  const named = angle
    ? header
        .slice(0, angle.index)
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .trim()
    : '';
  return { name: named || address.slice(0, at), address, domain };
}

/** Every address in a To or Cc header, lowercased. */
export function addressesIn(header: string): string[] {
  return (header.match(/[^\s<>"',;:]+@[^\s<>"',;:]+/g) ?? []).map((a) =>
    a.toLowerCase().replace(/^mailto:/, ''),
  );
}

const onDomain = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

export function isOwnOrStaff(address: string, own: readonly string[]): boolean {
  const a = address.toLowerCase();
  if (own.some((o) => o.toLowerCase() === a)) return true;
  const domain = a.split('@')[1] ?? '';
  return STAFF_DOMAINS.some((d) => onDomain(domain, d));
}

/** Services that send notices, newsletters and invites, never a founder's own update. */
const BLOCKED_DOMAINS = [
  'docsend.com',
  'substack.com',
  'beehiiv.com',
  'convertkit.com',
  'ghost.io',
  'medium.com',
  'linkedin.com',
  'google.com',
  'zoom.us',
  'calendly.com',
  'docusign.net',
  'docusign.com',
  'eventbrite.com',
  'luma-mail.com',
  'slack.com',
  'notion.so',
  'granola.so',
  'granola.ai',
];

const AUTOMATED_LOCAL =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|calendar(?:-notification)?|invitations?|automated|system|billing|receipts?|invoices?|marketing|newsletters?|news|digest)(?:[+._-].*)?$/i;

export function isAutomatedSender(sender: Sender): boolean {
  if (BLOCKED_DOMAINS.some((d) => onDomain(sender.domain, d))) return true;
  return AUTOMATED_LOCAL.test(sender.address.split('@')[0] ?? '');
}

/* ---------------------------------------------------------------- subjects */

export type UpdateKind = 'investor' | 'periodic' | 'metrics' | 'fundraise' | 'company';

export interface SubjectVerdict {
  kind: UpdateKind;
  /** Short label shown as a badge, e.g. "Investor update". */
  label: string;
  /**
   * The name a bare "<Name> Update" subject leads with. Anyone can write that
   * ("Baby Update!", "Lease Update"), so from outside the portfolio it counts
   * only when the name is the sender's own.
   */
  named?: string;
}

const REPLY_RE = /^\s*(?:re|aw|sv|antw)\s*(?:\[\d+\])?\s*:/i;
const FWD_RE = /^\s*(?:(?:fwd?|fw)\s*:\s*)+/i;
const CALENDAR_RE =
  /^(?:updated\s+)?invitation(?:\s+with\s+note)?\s*:|^(?:accepted|declined|tentatively accepted|tentative|canceled event|cancelled event|canceled|cancelled|new event|updated event|event canceled|event cancelled)\s*:|\binvitation from google calendar\b/i;
const INVESTOR_RE =
  /\b(?:investors?|shareholders?|stakeholders?|lps?|board|supporters?|backers?|angels?)['’]?\s+(?:update|letter|report|memo|newsletter|note)s?\b/i;
/** Words that mark a notice, a newsletter or a conversation, not a company update. */
const SOFT_EXCLUDE_RE =
  /\b(?:newsletter|digest|webinar|podcast|round-?up|this week in|weekly reads|edition|unsubscribe|% off|discount|promo(?:tion)?|black friday|cyber monday|register now|rsvp|save the date|you(?:'|’)?re invited|join us|livestream|live stream|office hours|meeting notes|notes from|transcript|summary of your|recap of your|product updates?|feature updates?|release notes|what(?:'|’)?s new|changelog|terms of (?:service|use)|privacy policy|security (?:update|alert|notice)|account (?:update|notice)|billing|invoice|receipt|payment|statement|password|verify|verification|confirm your|subscription|your order|your (?:account|plan|trial)|status update|quick update|small update|brief update|short update|personal update|scheduling update|schedule update|meeting update|calendar update|travel update|app update|software update|system update|service update|policy update|important update|industry update|market update)\b/i;
/**
 * Legal, tax, money-movement and planning mail. A portfolio company's lawyer
 * or a fund admin sends these with a quarter in the subject, and none of them
 * is the company telling Nick how it is doing.
 */
const PAPERWORK_RE =
  /\b(?:consents?|signatures?|signature pages?|(?:please|to|for|ready to)\s+(?:e-?)?sign|e-?sign(?:ing)?|docusign|docs|documents|paperwork|side letters?|409a|k-?1s?|w-?[89]|1099s?|tax(?:es)?|pro[- ]?rata|notices?|data ?rooms?|cap tables?|capital calls?|wires?|wiring|funds? (?:received|sent|wired|transfer)|okrs?|(?:hiring|operating|business|budget|annual|strategic|gtm|go-to-market|headcount)\s+plans?|planning|audit)\b/i;
/** A SAFE as paperwork, case-sensitive so "stay safe" is untouched. "SAFE round update" is a raise. */
const SAFE_NOUN_RE =
  /\bSAFEs?\b(?!\s+(?:round|raise|fundraise|update|progress|news|is open|now open|closing|oversubscribed))/;
const PERIODIC_RE =
  /\b(monthly|quarterly|weekly|bi-?weekly|bi-?monthly|annual|yearly|half[- ]?year(?:ly)?|mid[- ]?year|year[- ]end|end[- ]of[- ]year)\s+(?:founder\s+|company\s+|business\s+|team\s+|progress\s+)?(?:update|report|letter|recap|review|check[- ]?in|note)s?\b/i;
const MONTH_UPDATE_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(?:['’]\s?\d{2}|20\d{2})?\s+(?:founder\s+|company\s+|investor\s+|monthly\s+)?(?:update|report|letter|recap)s?\b/i;
/** A quarter or half with its year: Q3'26, Q3 2026, Q3 FY26, H2 2026. */
const QUARTER_TAG_RE =
  /\b(?:Q[1-4]|[1-4](?:st|nd|rd|th)\s+quarter|H[12])\s*(?:['’]\s?\d{2}\b|20\d{2}\b|FY\s?['’]?\d{2,4}\b)/i;
const QUARTER_WORD_RE =
  /\bQ[1-4]\b[^|]{0,30}?\b(?:update|report|letter|results|recap|review|metrics|highlights|numbers)\b/i;
/** A quarter tag alone ("Q4 2026 estimated taxes") says nothing; it needs one of these with it. */
const PERIOD_NOUN_RE =
  /\b(?:updates?|letter|report|results|recap|review|metrics|highlights|numbers|kpis?|ARR|MRR|revenue|financials)\b/i;
/** "… at Acme — Q3 2026", "… from Acme | Q3'26": the company, right before the quarter tag. */
const QUARTER_FROM_RE =
  /\b(?:at|from)\s+([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})\s*(?:[—–|:-]|,)\s*(?:Q[1-4]|[1-4](?:st|nd|rd|th)\s+quarter|H[12])\b/;
const METRIC_RE =
  /[$€£]\s?\d[\d.,]*\s?(?:k|m|mm|b|bn|million|thousand)?\b[^\n]{0,20}?\b(?:ARR|MRR|GMV|revenue|bookings)\b|\b(?:ARR|MRR)\b[^\n]{0,15}?[$€£]\s?\d/i;
const MEETING_RE = /\b(?:meeting|call|sync|agenda|offsite|session|dinner|lunch|coffee|planning)\b/i;
const DAY_RE = /\bday\s+#?\d{1,3}\b/i;
const RAISE_CONTEXT_RE =
  /\b(?:raise|raising|round|seed|series\s+[a-e]|fundrais\w*|safe|closing|update)\b/i;
const FUNDRAISE_RE =
  /\b(?:fundrais(?:e|ing)|raise|round|seed|pre-seed|series\s+[a-e]|bridge|safe)\s+(?:update|progress|news|is open|now open|closing|oversubscribed)\b/i;
/** "Hank Update: 63 locations", "Acme update - October", "HABU Update #12". */
const NAMED_HEAD_RE = /^([A-Z0-9][\w.&'’-]*(?:\s+[A-Z0-9][\w.&'’-]*){0,3})\s+[Uu]pdates?(?![\w])/;
/** What may follow "<Name> Update": punctuation, a number, the end, or a period. */
const NAMED_TAIL_RE =
  /^(?:\s*(?:[:\-–—|#(,!]|\d|$)|\s+(?:for|from|on)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|the (?:month|quarter|week))|\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b)/i;

/** The capitalised name before "Update" when the subject is "<Name> Update…". */
function namedCompany(subject: string): string | undefined {
  const m = NAMED_HEAD_RE.exec(subject);
  if (!m) return undefined;
  return NAMED_TAIL_RE.test(subject.slice(m[0].length)) ? m[1] : undefined;
}
const FROM_NAMED_RE =
  /^(?:an?\s+)?[Uu]pdate\s+from\s+([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,3})\s*(?:[:\-–—|(,!]|$)/;
const GENERIC_UPDATE_RE = /\b(?:company|founder|business|progress|startup)\s+updates?\b/i;

/** First words that make "<X> update" a kind of message, not a company's name. */
const NAME_STOP = new Set([
  'a',
  'an',
  'the',
  'your',
  'our',
  'my',
  'this',
  'quick',
  'small',
  'brief',
  'short',
  'big',
  'exciting',
  'important',
  'urgent',
  'final',
  'another',
  'status',
  'personal',
  'team',
  'product',
  'feature',
  'account',
  'billing',
  'security',
  'policy',
  'privacy',
  'schedule',
  'scheduling',
  'meeting',
  'calendar',
  'travel',
  'app',
  'software',
  'system',
  'service',
  'payment',
  'tax',
  'industry',
  'market',
  'news',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annual',
  'investor',
  'investors',
  'company',
  'founder',
  'progress',
  'project',
  'deal',
  'portfolio',
  'fund',
  'lp',
  'board',
  'legal',
  'closing',
  'hiring',
  'job',
  'application',
  'order',
  'shipping',
  'delivery',
  'event',
  'community',
  'program',
  'q1',
  'q2',
  'q3',
  'q4',
  'h1',
  'h2',
  'fy',
  'year',
  'yearly',
  // Months: "October Update" is a period, not a company.
  'january',
  'jan',
  'february',
  'feb',
  'march',
  'mar',
  'april',
  'apr',
  'may',
  'june',
  'jun',
  'july',
  'jul',
  'august',
  'aug',
  'september',
  'sept',
  'sep',
  'october',
  'oct',
  'november',
  'nov',
  'december',
  'dec',
  // Generic words and personal news.
  'highlights',
  'wins',
  'recap',
  'baby',
  'life',
  'family',
  'wedding',
  'birthday',
  'holiday',
  'vacation',
  'trip',
  'health',
  'house',
  'home',
  'moving',
  'move',
  'lease',
  'office',
  'candidate',
  'recruiting',
  'interview',
  'funding',
  'fundraise',
  'fundraising',
  'round',
  'seed',
  'series',
  'safe',
  'insurance',
  'benefits',
  'payroll',
  'website',
  'launch',
]);

function stripForward(subject: string): string {
  return subject.replace(FWD_RE, '').trim();
}

function periodicLabel(text: string): string {
  if (/\b(?:Q[1-4]|quarter(?:ly)?)\b/i.test(text)) return 'Quarterly update';
  if (/\bH[12]\b|half[- ]?year|mid[- ]?year/i.test(text)) return 'Half-year update';
  if (/\b(?:annual|yearly|year[- ]end|end[- ]of[- ]year)\b/i.test(text)) return 'Annual update';
  if (/\b(?:bi-?)?weekly\b/i.test(text)) return 'Weekly update';
  return 'Monthly update';
}

/** A year, a fiscal year or an apostrophe year: "2026", "FY26", "'26". */
const PERIOD_TOKEN_RE = /^(?:20\d{2}|fy\d{2,4}|\d{2})$/;

function namedOk(name: string | undefined): boolean {
  if (!name) return false;
  const words = name
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const first = words[0] ?? '';
  if (!first || NAME_STOP.has(first)) return false;
  // "2026 Update", "Q3 2026": a period on its own is not a name.
  return !words.every((w) => NAME_STOP.has(w) || PERIOD_TOKEN_RE.test(w));
}

const MONTH_NAMES =
  'january|february|march|april|may|june|july|august|september|october|november|december';
const COMPANY_NEWSLETTER_RE = new RegExp(
  String.raw`^([A-Za-z0-9][\w.&'’-]*(?:\s+[A-Za-z0-9][\w.&'’-]*){0,2}?)\s+(?:(?:${MONTH_NAMES})(?:\s+20\d{2})?|q[1-4](?:\s*['’]?\s*\d{2,4})?)\s+(?:investor\s+|company\s+)?newsletter\s*$`,
  'i',
);

/** Does this subject read like a company or investor update? Null when it doesn't. */
export function classifyUpdateSubject(subject: string): SubjectVerdict | null {
  const raw = subject.trim();
  if (!raw || REPLY_RE.test(raw)) return null;
  const s = stripForward(raw);
  if (!s || REPLY_RE.test(s) || CALENDAR_RE.test(s)) return null;
  if (INVESTOR_RE.test(s)) return { kind: 'investor', label: 'Investor update' };
  // "Plantiful September 2026 Newsletter": a founder's own periodic letter. The
  // name must still be the sender's company (screenCandidate checks), which is
  // what keeps marketing newsletters out.
  const letter = COMPANY_NEWSLETTER_RE.exec(s);
  if (letter && namedOk(letter[1])) {
    return {
      kind: 'periodic',
      label: /\bq[1-4]\b/i.test(s) ? 'Quarterly update' : 'Monthly update',
      named: trimQualifiers(letter[1]!),
    };
  }
  if (SOFT_EXCLUDE_RE.test(s) || PAPERWORK_RE.test(s) || SAFE_NOUN_RE.test(s)) return null;

  // "Q4 2026 board meeting prep" is a meeting about a period, not an update.
  const meeting = MEETING_RE.test(s);
  const quarterTag = QUARTER_TAG_RE.test(s) && PERIOD_NOUN_RE.test(s);
  if (!meeting && (quarterTag || QUARTER_WORD_RE.test(s) || PERIODIC_RE.test(s))) {
    return { kind: 'periodic', label: periodicLabel(s) };
  }
  // "Enterprise rollouts and team growth at Acme — Q3 2026": a quarter with its
  // year plus the company the letter is from. The name must still be the
  // sender's own company (screenCandidate checks), which keeps tax and
  // marketing subjects with a quarter in them out.
  const fromCompany = !meeting && QUARTER_TAG_RE.test(s) ? QUARTER_FROM_RE.exec(s) : null;
  if (fromCompany && namedOk(fromCompany[1])) {
    return { kind: 'periodic', label: periodicLabel(s), named: trimQualifiers(fromCompany[1]!) };
  }
  const month = MONTH_UPDATE_RE.exec(s);
  // "May" only as a capitalised month: "we may update" is not a monthly update.
  if (!meeting && month && /^[A-Z]/.test(month[1] ?? '')) {
    return { kind: 'periodic', label: 'Monthly update' };
  }
  if (METRIC_RE.test(s)) return { kind: 'metrics', label: 'Metrics in subject' };
  if ((DAY_RE.test(s) && RAISE_CONTEXT_RE.test(s)) || FUNDRAISE_RE.test(s)) {
    return { kind: 'fundraise', label: 'Fundraise update' };
  }
  const named = [namedCompany(s), FROM_NAMED_RE.exec(s)?.[1]].find((n) => namedOk(n));
  if (named) return { kind: 'company', label: 'Company update', named: trimQualifiers(named) };
  if (GENERIC_UPDATE_RE.test(s)) return { kind: 'company', label: 'Company update' };
  return null;
}

const QUALIFIER = String.raw`(?:weekly|bi-?weekly|monthly|quarterly|annual|investors?|founders?|company|board|lps?|shareholders?|stakeholders?|seed|pre-seed|round|fundrais(?:e|ing)|series\s+[a-e]|q[1-4](?:\s*['’]?\s*\d{2,4})?|h[12](?:\s*['’]?\s*\d{2,4})?|20\d{2})`;
/** "Cobalt Orchard weekly investor update", "Quillfeather seed round update - Day 4". */
const NAME_THEN_QUALIFIERS_RE = new RegExp(
  String.raw`^([A-Za-z0-9][\w.&'’-]*(?:\s+[A-Za-z0-9][\w.&'’-]*){0,2}?)\s+(?:${QUALIFIER}\s+)+(?:update|letter|report)s?\b`,
  'i',
);
const TRAILING_QUALIFIER = new RegExp(String.raw`\s+${QUALIFIER}$`, 'i');

function trimQualifiers(name: string): string {
  let out = name.replace(/[\s:–—|-]+$/, '').trim();
  for (let i = 0; i < 4 && TRAILING_QUALIFIER.test(out); i++) {
    out = out.replace(TRAILING_QUALIFIER, '').trim();
  }
  return out;
}

/** The company a subject names, when it leads with one: "Hank Update: …" -> "Hank". */
export function companyFromSubject(subject: string): string | null {
  const s = stripForward(subject);
  const candidates = [
    namedCompany(s),
    FROM_NAMED_RE.exec(s)?.[1],
    NAME_THEN_QUALIFIERS_RE.exec(s)?.[1],
    /^([A-Z][\w.&'’-]*(?:\s+(?!Q[1-4]\b|H[12]\b)[A-Z][\w.&'’-]*){0,2})(?=\s*[-–—|:]|\s+(?:Q[1-4]|H[12])\b)/.exec(
      s,
    )?.[1],
    /^(?:\w+\s+){0,2}(?:investor|monthly|quarterly|company|founder)\s+update\s*[-–—|:]\s*([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})/i.exec(
      s,
    )?.[1],
  ];
  for (const c of candidates) {
    if (!c || !/^[A-Z0-9]/.test(c)) continue;
    // "MovixTech September Update" names MovixTech, not "MovixTech September".
    const name = trimQualifiers(c)
      .replace(new RegExp(String.raw`\s+(?:${MONTH_NAMES})(?:\s+20\d{2})?$`, 'i'), '')
      .trim();
    if (name && namedOk(name) && !/\b(?:updates?|Q[1-4])$/i.test(name)) return name;
  }
  return null;
}

/* -------------------------------------------------------------- portfolio */

export interface CompanyLike {
  id: string;
  name: string;
  domain?: string | null;
  website?: string | null;
}

export type MatchBy = 'domain' | 'sender' | 'subject';

export interface PortfolioMatch {
  company: CompanyLike;
  by: MatchBy;
}

/**
 * Names that are ordinary words. A subject that merely contains one proves
 * nothing, so these need the sender's domain to agree.
 */
const GENERIC_NAMES = new Set([
  'hello',
  'update',
  'build',
  'open',
  'bridge',
  'market',
  'capital',
  'ventures',
  'health',
  'data',
  'cloud',
  'pay',
  'one',
  'next',
  'true',
  'home',
  'rise',
  'base',
  'core',
  'loop',
  'flow',
  'spark',
  'pulse',
  'beacon',
  'atlas',
  'nova',
  'apex',
  'summit',
  'harbor',
  'anchor',
  'signal',
  'vector',
  'ledger',
  'orbit',
  'echo',
  'relay',
  'scout',
  'pilot',
  'bloom',
  'wave',
  'stack',
  'shift',
  'mosaic',
  'canvas',
  'forge',
  'compass',
  'north',
  'peak',
  'prime',
  'quest',
  'sage',
  'venture',
  'fund',
  'invest',
  'seed',
  'series',
  'round',
  'angel',
  'monthly',
  'quarterly',
  'weekly',
  'investor',
  'investors',
  'board',
  'team',
  'company',
  'labs',
  'studio',
  'works',
  'group',
  'global',
  'partners',
  'network',
  'connect',
  'direct',
  'smart',
  'simple',
  'clear',
  'bright',
  'good',
  'better',
  'happy',
  'fresh',
  'local',
  'social',
  'mobile',
  'digital',
  'energy',
  'power',
  'solar',
  'water',
  'food',
  'care',
  'legal',
  'money',
  'credit',
  'cash',
  'trust',
  'safe',
  'secure',
  'hub',
  'link',
  'path',
  'field',
  'stone',
  'river',
  'ocean',
  'forest',
]);

const DOMAIN_PREFIXES = [
  'get',
  'try',
  'use',
  'join',
  'go',
  'hey',
  'hi',
  'hello',
  'with',
  'meet',
  'dial',
  'my',
  'the',
  'buy',
  'ask',
  'call',
  'team',
  'we',
  'app',
];
const DOMAIN_SUFFIXES = [
  'ai',
  'hq',
  'app',
  'apps',
  'labs',
  'lab',
  'inc',
  'co',
  'io',
  'tech',
  'health',
  'team',
  'data',
  'hub',
  'works',
  'group',
  'global',
  'systems',
  'software',
  'robotics',
  'bio',
  'pay',
  'usa',
];
const TWO_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'com.au',
  'co.in',
  'com.br',
  'co.nz',
  'co.za',
  'com.sg',
  'com.mx',
  'co.jp',
  'com.ph',
]);

/** "mail.maestra.io" -> "maestra"; "dialhank.com" -> "dialhank". */
export function domainLabel(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  const lastTwo = parts.slice(-2).join('.');
  const idx = TWO_PART_TLDS.has(lastTwo) && parts.length >= 3 ? parts.length - 3 : parts.length - 2;
  return parts[idx] ?? '';
}

const compactKey = (name: string) => normalizeCompanyName(name).replace(/\s+/g, '');

/** The sender's domain is the company's own: a strong match even for a short name. */
export function labelMatchesCompany(label: string, compact: string): boolean {
  if (compact.length < 3 || !label) return false;
  if (label === compact) return true;
  if (DOMAIN_PREFIXES.some((p) => label === `${p}${compact}`)) return true;
  return DOMAIN_SUFFIXES.some((s) => label === `${compact}${s}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Where the company's name appears in the subject as whole words, or null. */
export function nameInSubject(subject: string, name: string): 'lead' | 'anywhere' | null {
  const s = fold(stripForward(subject)).replace(/^[\s[("'“]+/, '');
  const variants = new Set<string>();
  const trimmed = fold(name).trim();
  if (trimmed) variants.add(escapeRe(trimmed).replace(/\s+/g, '\\s+'));
  const key = normalizeCompanyName(name);
  if (key) variants.add(key.split(' ').map(escapeRe).join('[\\s.-]+'));
  let best: 'lead' | 'anywhere' | null = null;
  for (const v of variants) {
    const m = new RegExp(`(?<![\\w])${v}(?![\\w])`, 'i').exec(s);
    if (!m) continue;
    if (m.index <= 1) return 'lead';
    best = 'anywhere';
  }
  return best;
}

function companyDomain(c: CompanyLike): string | null {
  return normalizeDomain(c.domain ?? null) ?? normalizeDomain(c.website ?? null);
}

/** How strongly this one company matches the sender and subject, or null. */
export function matchCompany(sender: Sender, subject: string, c: CompanyLike): MatchBy | null {
  const compact = compactKey(c.name);
  if (compact.length < 2) return null;
  const generic = GENERIC_NAMES.has(compact) || GENERIC_NAMES.has(normalizeCompanyName(c.name));
  const domain = companyDomain(c);
  if (domain && onDomain(sender.domain, domain)) return 'domain';
  const corporate = !isFreeEmailDomain(sender.domain);
  const label = corporate ? domainLabel(sender.domain) : '';
  const labelMatch = labelMatchesCompany(label, compact);
  const display = normalizeCompanyName(sender.name);
  const key = normalizeCompanyName(c.name);
  const senderIsCompany =
    key.length >= 3 &&
    (display === key ||
      new RegExp(
        `^${escapeRe(key)}\\s+(?:team|updates?|hq|investor relations|founders?|news)$`,
      ).test(display));
  const where = nameInSubject(subject, c.name);
  // The company's own domain; a generic name needs the sender or subject to agree.
  if (labelMatch && (!generic || senderIsCompany || where)) return 'domain';
  if (senderIsCompany && compact.length >= 5 && !generic) return 'sender';

  // A name in the subject proves little on its own: other people's mail names
  // portfolio companies too ("we signed Quillfeather", "VP Eng for Maestra",
  // a law firm's "Fernhollow Robotics Update: signature pages"). It counts only
  // when the name leads the subject and the sender is a person on free mail or
  // on a domain that looks like the company's own. It stays a weak match.
  if (where !== 'lead' || generic || compact.length < 4) return null;
  if (!corporate || ownLookingLabel(label, compact)) return 'subject';
  return null;
}

/** "fernhollow.ai" for "Fernhollow Robotics": the domain is the name's distinctive start. */
function ownLookingLabel(label: string, compact: string): boolean {
  return label.length >= 5 && compact.startsWith(label) && !GENERIC_NAMES.has(label);
}

/**
 * Is this name the sender's own company: their domain, or a display name like
 * "Ledgerly Team" or "Maya at Ledgerly"? Free mail never vouches for a name.
 */
export function nameMatchesSender(name: string, sender: Sender): boolean {
  const compact = compactKey(name);
  const key = normalizeCompanyName(name);
  if (compact.length < 3 || !key) return false;
  if (!isFreeEmailDomain(sender.domain)) {
    const label = domainLabel(sender.domain);
    if (labelMatchesCompany(label, compact) || ownLookingLabel(label, compact)) return true;
  }
  const display = normalizeCompanyName(sender.name);
  const k = escapeRe(key);
  return (
    display === key ||
    new RegExp(`^${k}\\s+(?:team|updates?|hq|investor relations|founders?|news)$`).test(display) ||
    new RegExp(`\\s(?:at|from)\\s+${k}$`).test(display) ||
    new RegExp(`[(|]\\s*${escapeRe(name.trim())}\\s*\\)?\\s*$`, 'i').test(sender.name)
  );
}

const RANK: Record<MatchBy, number> = { domain: 3, sender: 2, subject: 1 };

/** The one portfolio company this email is about. Two at the same strength is no match. */
export function matchPortfolio(
  sender: Sender,
  subject: string,
  companies: readonly CompanyLike[],
): PortfolioMatch | null {
  let best: PortfolioMatch | null = null;
  let tie = false;
  for (const company of companies) {
    const by = matchCompany(sender, subject, company);
    if (!by) continue;
    if (!best || RANK[by] > RANK[best.by]) {
      best = { company, by };
      tie = false;
    } else if (RANK[by] === RANK[best.by] && best.company.id !== company.id) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/* ------------------------------------------------------------ candidates */

export interface CandidateMessage {
  id: string;
  threadId: string;
  from: string;
  replyTo?: string;
  to: string;
  cc: string;
  subject: string;
  date: string | null;
  snippet: string;
  labelIds: string[];
  bulk: boolean;
}

export interface Screened {
  message: CandidateMessage;
  sender: Sender;
  verdict: SubjectVerdict;
  match: PortfolioMatch | null;
  /** None of Nick's addresses is in To or Cc. */
  bcc: boolean;
  /**
   * What to look up in Sent mail when the portfolio match is missing or only
   * by subject: a domain, or an address for free mail.
   */
  historyKey: string | null;
}

/** Matched by the company's domain or its own sender name, not just by the subject. */
function solidMatch(match: PortfolioMatch | null): boolean {
  return match !== null && match.by !== 'subject';
}

const SKIP_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);

/**
 * Services founders send investor updates through. The From address is the
 * service's; the founder is on Reply-To, so trust is checked against that.
 */
const UPDATE_PLATFORMS = [
  'visible.vc',
  'mcsv.net',
  'mailchimpapp.net',
  'mailchimp.com',
  'sendgrid.net',
  'hubspotemail.net',
  'hs-email.net',
  'intercom-mail.com',
];

/** Second-level labels under which a company's own domain has three parts. */
const TWO_PART_SUFFIX = /^(?:co|com|org|net|ac|gov)\.[a-z]{2}$/;

/** news.movixtech.com -> movixtech.com; acme.co.uk stays acme.co.uk. */
export function registrableDomain(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIX.test(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Whose history decides trust: the founder behind a platform send, keyed by
 * their company's registrable domain (or the full address for gmail.com and
 * the like), so an update from news.acme.com counts mail Nick sent to acme.com.
 */
export function historyKeyFor(sender: Sender, replyTo?: string): string {
  const who = founderBehind(sender, replyTo);
  return isFreeEmailDomain(who.domain) ? who.address : who.domain;
}

/**
 * The person behind an update: the Reply-To founder for a platform send, with
 * the company's registrable domain (news.acme.com -> acme.com).
 */
export function founderBehind(sender: Sender, replyTo?: string): Sender {
  let who = sender;
  if (UPDATE_PLATFORMS.some((d) => onDomain(sender.domain, d)) && replyTo) {
    const reply = parseSender(replyTo);
    if (reply && !UPDATE_PLATFORMS.some((d) => onDomain(reply.domain, d))) who = reply;
  }
  if (isFreeEmailDomain(who.domain)) return who;
  return { ...who, domain: registrableDomain(who.domain) };
}

/** Gmail search for mail Nick sent to that key. Only safe characters reach the query. */
export function historyQuery(key: string): string | null {
  const clean = key.toLowerCase();
  if (!/^[a-z0-9._%+@-]+$/.test(clean) || !clean.includes('.')) return null;
  return `in:sent to:${clean}`;
}

/**
 * First pass, headers only: drop what is plainly not a company update and
 * say whether a Sent-mail lookup is needed to trust the sender.
 */
export function screenCandidate(
  message: CandidateMessage,
  context: { own: readonly string[]; companies: readonly CompanyLike[] },
): Screened | null {
  const sender = parseSender(message.from);
  if (!sender) return null;
  if (isOwnOrStaff(sender.address, context.own)) return null;
  if (message.labelIds.some((l) => SKIP_LABELS.has(l))) return null;
  if (isAutomatedSender(sender)) return null;
  const verdict = classifyUpdateSubject(message.subject);
  if (!verdict) return null;
  const match = matchPortfolio(sender, message.subject, context.companies);
  const solid = solidMatch(match);
  const promo = message.labelIds.some(
    (l) => l === 'CATEGORY_PROMOTIONS' || l === 'CATEGORY_FORUMS',
  );
  if (promo && !solid) return null;
  // "Acme — AI for X | 45 paying customers | $111K ARR" is how cold pitches read:
  // numbers alone (no "update", quarter or month) count only from a portfolio company.
  if (verdict.kind === 'metrics' && !solid) return null;
  // A mailing list needs the company's own domain, an explicit investor update,
  // or a subject that names the sender's own company: founders send updates
  // through Visible, Mailchimp or a news subdomain. Nick must still have
  // emailed them (the history check that follows).
  if (message.bulk && !solid && verdict.kind !== 'investor') {
    const named = verdict.named ?? companyFromSubject(message.subject);
    const founder = founderBehind(sender, message.replyTo);
    const display = UPDATE_PLATFORMS.some((d) => onDomain(sender.domain, d))
      ? { ...founder, name: sender.name }
      : founder;
    if (!named || !(nameMatchesSender(named, founder) || nameMatchesSender(named, display))) {
      return null;
    }
  }
  // "Baby Update!", "Lease Update: signed": a bare "<Name> Update" from outside
  // the portfolio needs the name to be the sender's own company.
  if (!solid && verdict.named) {
    const sameAsMatch =
      match !== null && compactKey(match.company.name) === compactKey(verdict.named);
    if (!sameAsMatch && !nameMatchesSender(verdict.named, sender)) return null;
  }
  const recipients = new Set([...addressesIn(message.to), ...addressesIn(message.cc)]);
  const own = context.own.map((o) => o.toLowerCase());
  return {
    message,
    sender,
    verdict,
    match,
    bcc: !own.some((o) => recipients.has(o)),
    // A subject-only match still needs Nick to have emailed the sender.
    historyKey: solid ? null : historyKeyFor(sender, message.replyTo),
  };
}

export type TrustReason = 'portfolio' | 'emailed';

export interface CompanyUpdate {
  messageId: string;
  threadId: string;
  /** Portfolio company name, the company the subject leads with, or null. */
  company: string | null;
  companyId: string | null;
  sender: string;
  senderAddress: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  kind: UpdateKind;
  kindLabel: string;
  reason: TrustReason;
  bcc: boolean;
}

/** Gmail snippets arrive HTML-escaped. */
export function decodeSnippet(snippet: string): string {
  return snippet
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Second pass: keep it only when the sender is trusted. */
export function decideUpdate(screened: Screened, emailedBefore: boolean): CompanyUpdate | null {
  const { message, sender, verdict, match } = screened;
  if (!message.date) return null;
  const solid = solidMatch(match);
  let reason: TrustReason;
  if (solid) reason = 'portfolio';
  else if (emailedBefore) reason = 'emailed';
  else return null;
  // A name read off the subject heads the row only when it is the sender's own
  // company; otherwise the sender's name does ("October" is not a company).
  const named = companyFromSubject(message.subject);
  return {
    messageId: message.id,
    threadId: message.threadId,
    company: match?.company.name ?? (named && nameMatchesSender(named, sender) ? named : null),
    companyId: solid ? (match?.company.id ?? null) : null,
    sender: sender.name,
    senderAddress: sender.address,
    subject: message.subject.trim() || '(no subject)',
    snippet: decodeSnippet(message.snippet),
    receivedAt: message.date,
    kind: verdict.kind,
    kindLabel: verdict.label,
    reason,
    bcc: screened.bcc,
  };
}

/** Newest first, one per thread. */
export function newestPerThread(updates: readonly CompanyUpdate[]): CompanyUpdate[] {
  const byThread = new Map<string, CompanyUpdate>();
  for (const u of updates) {
    const seen = byThread.get(u.threadId);
    if (!seen || u.receivedAt > seen.receivedAt) byThread.set(u.threadId, u);
  }
  return [...byThread.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/* ------------------------------------------------------------ the digest */

const GMAIL_ID_IN_HREF = /#[a-z-]+\/([0-9a-f]{10,24})$/i;

/**
 * Gmail ids the update digest already linked to, mapped to when that run was
 * posted (the newest run that carried it). The routine's own "Open in Gmail"
 * links carry the id, so a match is certain; no match claims nothing.
 */
export function digestIndex(
  snapshot: { sources: readonly { posts: readonly UpdatePost[] }[] } | null,
): Map<string, string> {
  const index = new Map<string, string>();
  if (!snapshot) return index;
  const runs = snapshot.sources
    .flatMap((s) => s.posts)
    .filter((p): p is Extract<UpdatePost, { type: 'digest' }> => p.type === 'digest')
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  for (const run of runs) {
    for (const item of run.items) {
      for (const link of item.links) {
        const id = GMAIL_ID_IN_HREF.exec(link.href)?.[1]?.toLowerCase();
        if (id && !index.has(id)) index.set(id, run.postedAt);
      }
    }
  }
  return index;
}

/** When the digest carried this update, or null when it can't be told. */
export function digestedAt(
  update: Pick<CompanyUpdate, 'messageId' | 'threadId'>,
  index: ReadonlyMap<string, string>,
): string | null {
  return (
    index.get(update.messageId.toLowerCase()) ?? index.get(update.threadId.toLowerCase()) ?? null
  );
}
