import 'server-only';
import { NICK_ALIASES } from '@/lib/calendar/meetings';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { gmailThreadUrl } from '@/lib/deals/links';
import { listThreadPage } from '@/lib/google/gmail-inbox';
import { readThreadParticipants, type ThreadParticipants } from '@/lib/google/gmail-participants';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { isFreeEmailDomain } from '@/lib/util/text';
import { DEFAULT_MAILBOX } from './task-close';

/**
 * Warm intro paths for Fund II: who in Nick's own mail already knows someone
 * at a prospective LP, and who shares emails with them and could introduce
 * him. Read-only: a Gmail search for threads with the target's domain (or
 * exact address, for personal mail) over three years, then the From/To/Cc
 * headers of each message. No bodies are read and nothing is written.
 *
 * Honest by design: a firm name with no clear email domain in the mailbox,
 * or an LP thread with several outside parties on it, comes back as "unsure"
 * with what was seen, never a guess. A Gmail failure is an error, never an
 * empty answer.
 */

const LOOKBACK = 'newer_than:3y';
const MAX_THREADS = 30;
const TTL_MS = 30 * 60_000;
const FETCH_BATCH = 10;
const MAX_THREAD_CACHE = 3000;
/** A thread with more people than this is a mass email, not a relationship. */
export const MAX_GROUP = 12;
/** An introducer must have shared an email this small (or smaller) with the target. */
export const MAX_INTRO_MESSAGE = 6;
const TOP_KNOWN = 8;
const TOP_INTRODUCERS = 5;
const MAX_TARGET_DOMAINS = 3;
/** How many people (or domains) to offer when it is not clear who the LP is. */
const MAX_CHOICES = 6;

/** TipTop's own domains: staff are never the intro path. */
export const TIPTOP_DOMAINS = ['tiptop.vc', 'tiptopvc.com'] as const;

export interface Participant {
  email: string;
  name: string | null;
}

export interface ParsedMessage {
  /** Who sent it (normally one address). */
  from: string[];
  /** Everyone on its To or Cc. */
  recipients: string[];
}

export interface ParsedThread {
  id: string;
  subject: string;
  lastAt: string | null;
  /** Everyone on From, To or Cc of any message, one entry per address. */
  participants: Participant[];
  /**
   * Who was on each message. Links are worked out per message, so a forward
   * or a BCC'd letter never ties people together who never saw each other.
   */
  messages: ParsedMessage[];
}

export interface WarmTarget {
  /** `domain`: everyone at a firm's domain. `person`: exact addresses (personal mail). */
  kind: 'domain' | 'person';
  label: string;
  domains: string[];
  addresses: string[];
}

export interface WarmTally {
  email: string;
  name: string | null;
  /** Threads this person shares with the target (or, for the target's people, threads they are on). */
  threads: number;
  lastAt: string | null;
  /** The newest of those threads, as a sample to open. */
  threadId: string;
  subject: string;
}

export interface WarmPerson extends WarmTally {
  href: string | null;
}

export type WarmQuery =
  | { kind: 'email'; email: string }
  | { kind: 'thread'; thread: string; firm: string | null }
  | { kind: 'firm'; firm: string };

export interface WarmPaths {
  state: 'ok' | 'unsure' | 'no_target';
  /** A plain sentence for `unsure` and `no_target`. */
  message: string | null;
  target: WarmTarget | null;
  known: WarmPerson[];
  introducers: WarmPerson[];
  threadsSearched: number;
  groupThreadsSkipped: number;
  /** Domains that looked like the firm when it was not clear which one is theirs. */
  candidates: string[];
  /** People on the LP's thread to look up instead, when it was not clear who the LP is. */
  choices: Participant[];
  checkedAt: string;
}

export interface WarmContext {
  /** Nick's addresses and the connected mailbox, lower case. */
  ownAddresses: readonly string[];
  /** TipTop's domains. */
  ownDomains: readonly string[];
}

/* ------------------------------------------------------------ addresses */

const ADDRESS =
  /^[a-z0-9._%+'=-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** Strict enough to put inside a Gmail search: no braces, quotes or spaces. */
const SAFE_ADDRESS =
  /^[a-z0-9][a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Split an address header on commas and semicolons outside quotes, angle brackets and comments. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted) {
      current += ch;
      if (ch === '\\' && i + 1 < value.length) {
        i += 1;
        current += value[i];
      } else if (ch === '"') {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '(') comment += 1;
    else if (ch === ')') comment = Math.max(0, comment - 1);
    else if ((ch === ',' || ch === ';') && angle === 0 && comment === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function cleanName(raw: string | null, email: string): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  name = name
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!name || name.includes('@') || name.startsWith('=?') || name.toLowerCase() === email) {
    return null;
  }
  // "Doe, Jane" -> "Jane Doe", only for two plain words.
  const flipped = /^([\p{L}'-]+),\s*([\p{L}'-]+)$/u.exec(name);
  if (flipped) name = `${flipped[2]} ${flipped[1]}`;
  return name.slice(0, 80);
}

function parseOne(raw: string): Participant | null {
  let part = raw.trim();
  // Group syntax ("Team: a@x.com", "undisclosed-recipients:") and "mailto:".
  if (!part.startsWith('"')) {
    const group = /^[^"<>@:]*:\s*/.exec(part);
    if (group) part = part.slice(group[0].length);
  }
  if (!part) return null;
  let email: string;
  let name: string | null;
  const lastQuote = part.lastIndexOf('"');
  const tail = part.slice(lastQuote + 1);
  const angle = /<([^<>]+)>/.exec(tail);
  if (angle) {
    email = angle[1]!;
    name = part.slice(0, lastQuote + 1 + angle.index);
  } else {
    // "jane@x.com (Jane Doe)"
    name = /\(([^()]*)\)/.exec(part)?.[1] ?? null;
    email = part.replace(/\([^()]*\)/g, '');
  }
  email = email
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();
  if (!ADDRESS.test(email)) return null;
  return { email, name: cleanName(name, email) };
}

/** `Jane Doe <jane@x.com>, "Roe, Rick" <rick@y.com>, c@d.com` -> one entry per valid address. */
export function parseParticipants(header: string | null | undefined): Participant[] {
  if (!header) return [];
  const out: Participant[] = [];
  const seen = new Set<string>();
  for (const part of splitAddressList(header)) {
    const p = parseOne(part);
    if (!p || seen.has(p.email)) continue;
    seen.add(p.email);
    out.push(p);
  }
  return out;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc', 'or']);

/** `mail.harbor.co.uk` -> `harbor.co.uk`; `eu.harbor.com` -> `harbor.com`. */
export function registrableDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels.at(-1)!;
  const sld = labels.at(-2)!;
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join('.');
}

const PERSONAL_EXTRA = new Set([
  'mac.com',
  'ymail.com',
  'rocketmail.com',
  'pm.me',
  'duck.com',
  'tutanota.com',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'web.de',
  'qq.com',
  '163.com',
  '126.com',
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'btinternet.com',
]);

/** Personal mail, where the domain says nothing about who someone works with. */
export function isPersonalDomain(domain: string): boolean {
  const host = domain.toLowerCase();
  return (
    isFreeEmailDomain(host) ||
    PERSONAL_EXTRA.has(host) ||
    /^(?:yahoo|hotmail|outlook|live|gmx|aol|icloud)\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host)
  );
}

const ROLE_LOCAL =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|calendar(?:-notification|-server)?|invitations?|invites?|updates?|news(?:letters?)?|digest|marketing|billing|receipts?|support|help|info|hello|team|admin|contact|sales|events?|feedback|unsubscribe|reply|replies)(?:[+._-].*)?$/;
const BULK_HOST = /^(?:reply|replies|bounce|bounces|notifications?|news|email|mailer)\./;
const BULK_DOMAINS = [
  'docsend.com',
  'calendly.com',
  'zoom.us',
  'linkedin.com',
  'substack.com',
  'googlegroups.com',
  'calendar.google.com',
  'mailchimp.com',
  'mcsv.net',
  'sendgrid.net',
  'hubspotemail.net',
  'intercom-mail.com',
  'docusign.net',
];

/** Machines, role inboxes and lists: never a person to know or to ask for an intro. */
export function isBulkAddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();
  if (ROLE_LOCAL.test(local) || local.includes('=') || local.length > 40) return true;
  if (BULK_HOST.test(host)) return true;
  return BULK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Nick's aliases, the connected mailbox and TipTop's domains. */
export function warmContext(accountEmail: string | null | undefined): WarmContext {
  const account = accountEmail?.trim().toLowerCase() ?? '';
  const ownDomains = new Set<string>(TIPTOP_DOMAINS);
  const accountDomain = account.includes('@') ? domainOf(account) : '';
  if (accountDomain && !isPersonalDomain(accountDomain)) ownDomains.add(accountDomain);
  return {
    ownAddresses: [...new Set([...NICK_ALIASES, ...(account ? [account] : [])])].map((a) =>
      a.toLowerCase(),
    ),
    ownDomains: [...ownDomains],
  };
}

function isOwn(email: string, ctx: WarmContext): boolean {
  if (ctx.ownAddresses.includes(email)) return true;
  const host = domainOf(email);
  return ctx.ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function matchesTarget(email: string, target: WarmTarget): boolean {
  if (target.addresses.includes(email)) return true;
  const host = domainOf(email);
  return target.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/* --------------------------------------------------------------- targets */

/** A corporate address means its firm's domain; personal mail means that exact address. */
export function targetFromEmail(email: string): WarmTarget {
  const address = email.trim().toLowerCase();
  const host = domainOf(address);
  if (isPersonalDomain(host)) {
    return { kind: 'person', label: address, domains: [], addresses: [address] };
  }
  const domain = registrableDomain(host);
  return { kind: 'domain', label: domain, domains: [domain], addresses: [] };
}

const FIRM_WORDS = new Set([
  'the',
  'and',
  'of',
  'capital',
  'ventures',
  'venture',
  'vc',
  'partners',
  'partner',
  'management',
  'mgmt',
  'group',
  'llc',
  'inc',
  'lp',
  'llp',
  'ltd',
  'co',
  'company',
  'fund',
  'funds',
  'family',
  'office',
  'offices',
  'holdings',
  'advisors',
  'advisers',
  'investments',
  'investment',
  'invest',
  'investors',
  'asset',
  'assets',
  'equity',
  'private',
  'global',
  'associates',
  'foundation',
  'endowment',
  'trust',
  'wealth',
  'fof',
  'fo',
  'growth',
]);

const DOMAIN_SUFFIXES = new Set([
  'capital',
  'cap',
  'ventures',
  'venture',
  'vc',
  'vcs',
  'vp',
  'partners',
  'lp',
  'llc',
  'fund',
  'funds',
  'group',
  'hq',
  'inc',
  'co',
  'invest',
  'investments',
  'fo',
  'family',
  'familyoffice',
  'office',
  'mgmt',
  'management',
  'holdings',
  'am',
  'pe',
  'global',
  'wealth',
  'fof',
  'equity',
  'advisors',
  'foundation',
  'endowment',
  'growth',
]);

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Does this domain belong to the firm? `Lakeside Family Office` matches
 * lakeside.com, lakesidefo.com and lakeside-family-office.com; `Accel` does
 * not match accelerator.org (the leftover "erator" is not a firm suffix).
 */
export function firmMatchesDomain(firm: string, domain: string): boolean {
  const host = domain.toLowerCase();
  if (isPersonalDomain(host)) return false;
  const label = (registrableDomain(host).split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
  if (label.length < 3) return false;
  const tokens = words(firm);
  const full = tokens.join('');
  const core = tokens.filter((t) => !FIRM_WORDS.has(t)).join('') || full;
  if (!full) return false;
  if (label === full || label === core) return true;
  if (core.length < 4 || !label.startsWith(core)) return false;
  const rest = label.slice(core.length);
  if (DOMAIN_SUFFIXES.has(rest)) return true;
  return [...DOMAIN_SUFFIXES].some(
    (a) => rest.startsWith(a) && DOMAIN_SUFFIXES.has(rest.slice(a.length)),
  );
}

export type ThreadTarget =
  | { kind: 'found'; target: WarmTarget }
  /** Nobody outside TipTop (apart from machines) is on the thread. */
  | { kind: 'nobody' }
  /**
   * More than one outside party, and no firm name to tell which is the LP.
   * On an intro thread the introducer is one of them, so nothing is merged.
   */
  | { kind: 'unclear'; seen: string[]; people: Participant[] };

/**
 * Who on a thread is the target. With the LP's firm name, the domain that
 * matches it (labelled by the firm). Otherwise only a single outside party,
 * labelled by its own domain or address: with two or more (an introducer, a
 * lawyer, the LP on Gmail) it is `unclear`, never everyone merged together.
 */
export function targetFromParticipants(
  participants: readonly Participant[],
  ctx: WarmContext,
  firm: string | null = null,
): ThreadTarget {
  const domainCounts = new Map<string, number>();
  const personal: string[] = [];
  const people: Participant[] = [];
  for (const p of participants) {
    if (isOwn(p.email, ctx) || isBulkAddress(p.email)) continue;
    const host = domainOf(p.email);
    if (isPersonalDomain(host)) {
      // An address that is unsafe to search for is never used.
      if (!SAFE_ADDRESS.test(p.email)) continue;
      if (!personal.includes(p.email)) personal.push(p.email);
    } else {
      const d = registrableDomain(host);
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
    if (SAFE_ADDRESS.test(p.email) && !people.some((x) => x.email === p.email)) {
      people.push({ ...p });
    }
  }
  const domains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d]) => d);
  if (firm) {
    const matched = domains.filter((d) => firmMatchesDomain(firm, d));
    if (matched.length > 0) {
      return {
        kind: 'found',
        target: {
          kind: 'domain',
          label: firm,
          domains: matched.slice(0, MAX_TARGET_DOMAINS),
          addresses: [],
        },
      };
    }
  }
  const seen = [...domains, ...personal];
  if (seen.length === 0) return { kind: 'nobody' };
  if (seen.length > 1) {
    return {
      kind: 'unclear',
      seen: seen.slice(0, MAX_CHOICES),
      people: people.slice(0, MAX_CHOICES),
    };
  }
  // One outside party: that is who the thread is with. A firm name that did
  // not match its domain is not used as the label.
  const domain = domains[0];
  if (domain) {
    return {
      kind: 'found',
      target: { kind: 'domain', label: domain, domains: [domain], addresses: [] },
    };
  }
  const address = personal[0]!;
  return {
    kind: 'found',
    target: { kind: 'person', label: address, domains: [], addresses: [address] },
  };
}

/**
 * Everyone on a thread who exchanged a message directly with our side: they
 * wrote to Nick or TipTop (on To or Cc), or Nick or TipTop wrote to them.
 * A BCC'd letter, where our side is not on the headers, is not a link.
 */
function directWithUs(t: ParsedThread, ctx: WarmContext): Set<string> {
  const out = new Set<string>();
  for (const m of t.messages) {
    if (m.from.some((e) => isOwn(e, ctx))) for (const e of m.recipients) out.add(e);
    if (m.recipients.some((e) => isOwn(e, ctx))) for (const e of m.from) out.add(e);
  }
  return out;
}

/**
 * The firm's domain from who exchanged mail directly with Nick or TipTop on
 * threads mentioning it (a BCC'd letter or a newsletter does not count).
 * Confident only when one matching domain clearly leads; otherwise null with
 * what was seen.
 */
export function inferFirmDomain(
  firm: string,
  threads: readonly ParsedThread[],
  ctx: WarmContext,
): { domain: string | null; candidates: string[] } {
  const counts = new Map<string, number>();
  for (const t of threads) {
    const seen = new Set<string>();
    for (const email of directWithUs(t, ctx)) {
      if (isOwn(email, ctx) || isBulkAddress(email)) continue;
      const host = domainOf(email);
      if (isPersonalDomain(host)) continue;
      seen.add(registrableDomain(host));
    }
    for (const d of seen) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const matched = [...counts.entries()]
    .filter(([d]) => firmMatchesDomain(firm, d))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [top, second] = matched;
  if (!top) return { domain: null, candidates: [] };
  if (!second || top[1] >= 2 * second[1]) {
    return { domain: top[0], candidates: matched.map(([d]) => d) };
  }
  return { domain: null, candidates: matched.slice(0, 5).map(([d]) => d) };
}

/** `{from:x to:x cc:x} newer_than:3y` for every domain and address of the target. */
export function targetQuery(target: WarmTarget): string {
  const terms = [...target.domains, ...target.addresses].flatMap((x) => [
    `from:${x}`,
    `to:${x}`,
    `cc:${x}`,
  ]);
  return `{${terms.join(' ')}} ${LOOKBACK}`;
}

/* ------------------------------------------------------------- threads */

/** Everyone on a thread and on each message, with the newest message time. */
export function toParsedThread(raw: ThreadParticipants): ParsedThread {
  const byEmail = new Map<string, Participant>();
  const add = (p: Participant) => {
    const seen = byEmail.get(p.email);
    if (!seen) byEmail.set(p.email, { ...p });
    else if (!seen.name && p.name) seen.name = p.name;
  };
  const messages: ParsedMessage[] = [];
  for (const m of raw.messages) {
    const from = parseParticipants(m.from);
    const recipients = [...parseParticipants(m.to), ...parseParticipants(m.cc)];
    for (const p of [...from, ...recipients]) add(p);
    if (from.length === 0 && recipients.length === 0) continue;
    messages.push({
      from: from.map((p) => p.email),
      recipients: [...new Set(recipients.map((p) => p.email))],
    });
  }
  const dates = raw.messages
    .map((m) => m.at)
    .filter((d): d is string => Boolean(d))
    .sort();
  return {
    id: raw.id,
    subject: raw.subject,
    lastAt: dates.at(-1) ?? null,
    participants: [...byEmail.values()],
    messages,
  };
}

function bump(map: Map<string, WarmTally>, p: Participant, t: ParsedThread) {
  const cur = map.get(p.email);
  if (!cur) {
    map.set(p.email, {
      email: p.email,
      name: p.name,
      threads: 1,
      lastAt: t.lastAt,
      threadId: t.id,
      subject: t.subject,
    });
    return;
  }
  cur.threads += 1;
  if (!cur.name && p.name) cur.name = p.name;
  if ((t.lastAt ?? '') > (cur.lastAt ?? '')) {
    cur.lastAt = t.lastAt;
    cur.threadId = t.id;
    cur.subject = t.subject;
  }
}

const rank = (a: WarmTally, b: WarmTally) =>
  b.threads - a.threads ||
  (b.lastAt ?? '').localeCompare(a.lastAt ?? '') ||
  a.email.localeCompare(b.email);

/**
 * Who Nick already knows at the target, and who else could introduce him.
 * Worked out per message, not per thread:
 * - known: someone at the target who exchanged a message directly with Nick
 *   or TipTop (wrote to them, or was written to by them);
 * - introducer: someone outside the target and TipTop who was on the same
 *   message as someone at the target. Whoever Nick forwards an LP's email to
 *   never saw the LP, so they do not count.
 * Mass emails (more than MAX_GROUP people) are left out of both; TipTop, Nick,
 * machines and the target's own people never count as an intro path.
 */
export function buildWarmPaths(
  threads: readonly ParsedThread[],
  target: WarmTarget,
  ctx: WarmContext,
): { known: WarmTally[]; introducers: WarmTally[]; used: number; groupSkipped: number } {
  const known = new Map<string, WarmTally>();
  const intro = new Map<string, WarmTally>();
  const done = new Set<string>();
  const isTheirs = (email: string) =>
    matchesTarget(email, target) && !isOwn(email, ctx) && !isBulkAddress(email);
  let used = 0;
  let groupSkipped = 0;
  for (const t of threads) {
    if (done.has(t.id)) continue;
    done.add(t.id);
    const people = t.participants.filter((p) => !isBulkAddress(p.email));
    const theirs = people.filter((p) => isTheirs(p.email));
    if (theirs.length === 0) continue;
    if (people.length > MAX_GROUP) {
      groupSkipped += 1;
      continue;
    }
    const direct = directWithUs(t, ctx);
    const sharedMessage = new Set<string>();
    for (const m of t.messages) {
      const on = [...m.from, ...m.recipients];
      if (!on.some(isTheirs)) continue;
      // A group invite or event thread doesn't make someone an intro path:
      // only a small email they shared with the target counts.
      if (new Set(on.filter((e) => !isBulkAddress(e))).size > MAX_INTRO_MESSAGE) continue;
      for (const e of on) if (!matchesTarget(e, target) && !isOwn(e, ctx)) sharedMessage.add(e);
    }
    const knownHere = theirs.filter((p) => direct.has(p.email));
    const introHere = people.filter((p) => sharedMessage.has(p.email));
    if (knownHere.length === 0 && introHere.length === 0) continue;
    used += 1;
    for (const p of knownHere) bump(known, p, t);
    for (const p of introHere) bump(intro, p, t);
  }
  return {
    known: [...known.values()].sort(rank).slice(0, TOP_KNOWN),
    introducers: [...intro.values()].sort(rank).slice(0, TOP_INTRODUCERS),
    used,
    groupSkipped,
  };
}

/* ---------------------------------------------------------- validation */

const EMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const THREAD = /^[0-9a-f]{10,24}$/;
const FIRM = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &.,'’()/+-]*$/u;

/** A firm name safe to search as a quoted Gmail phrase, or null. */
export function searchableFirm(firm: string | null | undefined): string | null {
  if (!firm) return null;
  const clean = firm.replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 120 || !FIRM.test(clean)) return null;
  if ((clean.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return null;
  return clean;
}

const KEYS = new Set(['email', 'thread', 'firm']);

/** `?email=` alone, `?thread=` (with an optional `firm` hint) or `?firm=` alone. */
export function parseWarmPathsQuery(params: URLSearchParams): Result<WarmQuery> {
  for (const key of params.keys()) {
    if (!KEYS.has(key) || params.getAll(key).length > 1) {
      return err('invalid_input', 'Ask about one person, thread or firm.');
    }
  }
  const email = params.get('email');
  const thread = params.get('thread');
  const firmRaw = params.get('firm');
  if (email !== null) {
    if (thread !== null || firmRaw !== null) {
      return err('invalid_input', 'Ask about one person, thread or firm.');
    }
    const address = email.trim().toLowerCase();
    if (address.length > 254 || !EMAIL.test(address)) {
      return err('invalid_input', "That email address doesn't look right.");
    }
    return ok({ kind: 'email', email: address });
  }
  const firm = firmRaw === null ? null : searchableFirm(firmRaw);
  if (firmRaw !== null && !firm) return err('invalid_input', "That firm name can't be searched.");
  if (thread !== null) {
    const id = thread.trim().toLowerCase();
    if (!THREAD.test(id)) return err('invalid_input', "That thread doesn't look right.");
    return ok({ kind: 'thread', thread: id, firm });
  }
  if (firm) return ok({ kind: 'firm', firm });
  return err('invalid_input', 'Say who to look for: an email, a thread or a firm.');
}

/* -------------------------------------------------------------- service */

const cache = processWide('warm-paths', () => ({
  results: new Map<string, { at: number; value: WarmPaths }>(),
  /** `null`: the thread is gone or holds only drafts. */
  threads: new Map<string, { at: number; thread: ParsedThread | null }>(),
}));

/** Test hook. */
export function resetWarmPathsCache(): void {
  cache.results.clear();
  cache.threads.clear();
}

function queryKey(q: WarmQuery): string {
  if (q.kind === 'email') return `email:${q.email}`;
  if (q.kind === 'thread') return `thread:${q.thread}:${q.firm?.toLowerCase() ?? ''}`;
  return `firm:${q.firm.toLowerCase()}`;
}

const SEARCH_FAILED = "Couldn't search your mail right now. Try again in a minute.";
const READ_FAILED = "Couldn't read all of those threads from Gmail. Try again in a minute.";

async function searchThreadIds(
  store: DataStore,
  integration: Integration,
  q: string,
): Promise<Result<string[]>> {
  const page = await listThreadPage(store, integration, { q, max: MAX_THREADS });
  if (!page.ok) return err('provider_unavailable', SEARCH_FAILED, { retryable: true });
  return ok([...new Set(page.value.threads.map((t) => t.id))]);
}

/**
 * The headers of these threads, from the cache where fresh. `failed` counts
 * reads that went wrong (rate limits, outages): the caller must not build an
 * answer from a partial read. A thread that is gone, or holds only drafts, is
 * not a failure; it simply has nobody on it.
 */
async function readThreads(
  store: DataStore,
  integration: Integration,
  ids: readonly string[],
  now: number,
): Promise<{ threads: ParsedThread[]; failed: number }> {
  const got = new Map<string, ParsedThread | null>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = cache.threads.get(id);
    if (hit && now - hit.at < TTL_MS) got.set(id, hit.thread);
    else missing.push(id);
  }
  let failed = 0;
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const batch = missing.slice(i, i + FETCH_BATCH);
    const reads = await Promise.all(
      batch.map((id) => readThreadParticipants(store, integration, id).catch(() => null)),
    );
    batch.forEach((id, j) => {
      const r = reads[j];
      let thread: ParsedThread | null;
      if (r?.ok) thread = toParsedThread(r.value);
      else if (r?.error.code === 'not_found') thread = null;
      else {
        // Retried next time, never remembered as empty.
        failed += 1;
        return;
      }
      got.set(id, thread);
      cache.threads.set(id, { at: now, thread });
    });
  }
  if (cache.threads.size > MAX_THREAD_CACHE) {
    for (const [id, hit] of cache.threads) if (now - hit.at >= TTL_MS) cache.threads.delete(id);
    if (cache.threads.size > MAX_THREAD_CACHE) cache.threads.clear();
  }
  // Answered from `got`, so trimming the cache above never drops a thread just read.
  const threads = ids.flatMap((id) => {
    const thread = got.get(id);
    return thread ? [thread] : [];
  });
  return { threads, failed };
}

const withHref = (t: WarmTally): WarmPerson => ({
  ...t,
  href: gmailThreadUrl(t.threadId, DEFAULT_MAILBOX),
});

function answer(now: Date, fields: Partial<WarmPaths> & Pick<WarmPaths, 'state'>): WarmPaths {
  return {
    message: null,
    target: null,
    known: [],
    introducers: [],
    threadsSearched: 0,
    groupThreadsSkipped: 0,
    candidates: [],
    choices: [],
    checkedAt: now.toISOString(),
    ...fields,
  };
}

/** Either who to look for, or an answer already (nobody, or not sure who). */
type Resolved = { target: WarmTarget } | { answer: WarmPaths };

/**
 * The firm's domain from mail mentioning it. When the LP's thread did not
 * show it, what the thread did show is offered alongside, never guessed.
 */
async function resolveFirm(
  store: DataStore,
  integration: Integration,
  firm: string,
  ctx: WarmContext,
  now: Date,
  onThread: { seen: string[]; people: Participant[] } | null,
): Promise<Result<Resolved>> {
  const ids = await searchThreadIds(store, integration, `"${firm}" -from:docsend.com ${LOOKBACK}`);
  if (!ids.ok) return ids;
  const read = await readThreads(store, integration, ids.value, now.getTime());
  if (read.failed > 0) return err('provider_unavailable', READ_FAILED, { retryable: true });
  const inferred = inferFirmDomain(firm, read.threads, ctx);
  if (inferred.domain) {
    return ok({
      target: { kind: 'domain', label: firm, domains: [inferred.domain], addresses: [] },
    });
  }
  const candidates = [...new Set([...inferred.candidates, ...(onThread?.seen ?? [])])].slice(
    0,
    MAX_CHOICES,
  );
  return ok({
    answer: answer(now, {
      state: 'unsure',
      message:
        candidates.length > 0
          ? `Couldn't tell which email domain is ${firm}'s, so nothing was guessed.`
          : `Couldn't find an email domain for ${firm} in your mail.`,
      candidates,
      choices: onThread?.people ?? [],
    }),
  });
}

async function resolveTarget(
  store: DataStore,
  integration: Integration,
  query: WarmQuery,
  ctx: WarmContext,
  now: Date,
): Promise<Result<Resolved>> {
  if (query.kind === 'email') {
    if (isOwn(query.email, ctx)) {
      return ok({
        answer: answer(now, { state: 'no_target', message: 'That is a TipTop address.' }),
      });
    }
    return ok({ target: targetFromEmail(query.email) });
  }
  if (query.kind === 'firm') return resolveFirm(store, integration, query.firm, ctx, now, null);

  const raw = await readThreadParticipants(store, integration, query.thread);
  if (!raw.ok && raw.error.code !== 'not_found') {
    return err(
      'provider_unavailable',
      "Couldn't read that thread from Gmail. Try again in a minute.",
      { retryable: true },
    );
  }
  const found: ThreadTarget = raw.ok
    ? targetFromParticipants(toParsedThread(raw.value).participants, ctx, query.firm)
    : { kind: 'nobody' };
  if (found.kind === 'found') return ok({ target: found.target });
  // The thread did not show the LP's firm: look the firm up by name instead.
  if (query.firm) {
    return resolveFirm(
      store,
      integration,
      query.firm,
      ctx,
      now,
      found.kind === 'unclear' ? found : null,
    );
  }
  if (found.kind === 'unclear') {
    return ok({
      answer: answer(now, {
        state: 'unsure',
        message:
          "More than one person outside TipTop is on that thread, so it isn't clear who the LP is. Nothing was guessed.",
        candidates: found.seen,
        choices: found.people,
      }),
    });
  }
  return ok({
    answer: answer(now, {
      state: 'no_target',
      message: raw.ok
        ? 'Nobody outside TipTop is on that thread.'
        : "That thread isn't in your mail anymore.",
    }),
  });
}

async function compute(
  store: DataStore,
  integration: Integration,
  query: WarmQuery,
  ctx: WarmContext,
  now: Date,
): Promise<Result<WarmPaths>> {
  const resolved = await resolveTarget(store, integration, query, ctx, now);
  if (!resolved.ok) return resolved;
  if ('answer' in resolved.value) return ok(resolved.value.answer);
  const { target } = resolved.value;

  const ids = await searchThreadIds(store, integration, targetQuery(target));
  if (!ids.ok) return ids;
  const read = await readThreads(store, integration, ids.value, now.getTime());
  // A partial read would look like an honest "nobody" (and be cached): say so instead.
  if (read.failed > 0) return err('provider_unavailable', READ_FAILED, { retryable: true });
  const built = buildWarmPaths(read.threads, target, ctx);
  return ok(
    answer(now, {
      state: 'ok',
      target,
      known: built.known.map(withHref),
      introducers: built.introducers.map(withHref),
      threadsSearched: built.used,
      groupThreadsSkipped: built.groupSkipped,
    }),
  );
}

/** Warm intro paths for one person, thread or firm, cached for 30 minutes. */
export async function findWarmPaths(
  store: DataStore,
  organizationId: string,
  integration: Integration | null,
  query: WarmQuery,
  options: { now?: Date; force?: boolean } = {},
): Promise<Result<WarmPaths>> {
  const now = options.now ?? new Date();
  if (isDemoMode()) return ok(demoWarmPaths(query, now));
  if (!integration || integration.status === 'disconnected') {
    return err('not_configured', 'Connect Gmail in Settings to look for intro paths.');
  }
  const key = `${organizationId}|${queryKey(query)}`;
  const hit = cache.results.get(key);
  if (!options.force && hit && now.getTime() - hit.at < TTL_MS) return ok(hit.value);
  const result = await compute(
    store,
    integration,
    query,
    warmContext(integration.account_email),
    now,
  );
  // Only complete answers are kept: a Gmail failure (even one thread) is an
  // error, so it is never remembered as "nobody" for 30 minutes.
  if (result.ok) cache.results.set(key, { at: now.getTime(), value: result.value });
  return result;
}

/* ---------------------------------------------------------------- demo */

/** Fictional answer for demo mode. */
export function demoWarmPaths(query: WarmQuery, now: Date): WarmPaths {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const slug = (s: string) => words(s).join('').slice(0, 24) || 'quietpine';
  const target: WarmTarget =
    query.kind === 'email'
      ? targetFromEmail(query.email)
      : query.firm
        ? {
            kind: 'domain',
            label: query.firm,
            domains: [`${slug(query.firm)}.demo`],
            addresses: [],
          }
        : { kind: 'domain', label: 'quietpine.demo', domains: ['quietpine.demo'], addresses: [] };
  const domain = target.domains[0];
  const known: WarmTally[] = domain
    ? [
        {
          email: `jordan@${domain}`,
          name: 'Jordan Ellis',
          threads: 4,
          lastAt: ago(12),
          threadId: 'de0a00000000a001',
          subject: 'Coffee next time you are in Austin',
        },
        {
          email: `mei@${domain}`,
          name: 'Mei Tanaka',
          threads: 1,
          lastAt: ago(240),
          threadId: 'de0a00000000a002',
          subject: 'Intro: Northwind <> Mei',
        },
      ]
    : [
        {
          email: target.addresses[0] ?? 'someone@example.com',
          name: null,
          threads: 2,
          lastAt: ago(30),
          threadId: 'de0a00000000a003',
          subject: 'Great to meet at the summit',
        },
      ];
  const introducers: WarmTally[] = [
    {
      email: 'dana@birchlane.demo',
      name: 'Dana Whitfield',
      threads: 3,
      lastAt: ago(20),
      threadId: 'de0a00000000b001',
      subject: 'Dinner list for the fall LP meetup',
    },
    {
      email: 'marco.ruiz@gmail.com',
      name: 'Marco Ruiz',
      threads: 2,
      lastAt: ago(75),
      threadId: 'de0a00000000b002',
      subject: 'Re: co-invest in Quill',
    },
    {
      email: 'hannah@coleandpark.demo',
      name: 'Hannah Cole',
      threads: 1,
      lastAt: ago(300),
      threadId: 'de0a00000000b003',
      subject: 'Board intro follow-up',
    },
  ];
  return answer(now, {
    state: 'ok',
    target,
    known: known.map(withHref),
    introducers: introducers.map(withHref),
    threadsSearched: 7,
  });
}
