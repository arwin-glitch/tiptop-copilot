import { labelText } from './labels';
import type { EventLabel, RangeEvent } from './range-types';

/**
 * A suggested colour label for an unlabelled event, from what Copilot
 * already knows, and only one of the calendar's own labels (never a new
 * one). It is a suggestion until a person taps "Use it"; nothing here
 * writes. With no clear sign, or when no single label's name fits, there is
 * no suggestion: better none than a wrong one (D-070). With people of several
 * kinds on it, the first kind below decides: a board meeting with other
 * VCs on it is Portfolio.
 *
 * - Guests from a portfolio company: a label named like Portfolio / Portcos.
 * - A founder of a deal in the pipeline: Founders, or Diligence when the
 *   deal is in diligence.
 * - An LP or Fund II prospect: a label named like LPs / Investor relations.
 * - People from other VC firms: VCs / Investors / Co-investors.
 * - Only people from Nick's own team: Internal / Team.
 * - A flight, hotel or booking: Travel. An event registration: Event.
 *
 * Pure: the knowledge is gathered in lib/services/calendar-labels.ts.
 */

export type LabelCategory =
  'portfolio' | 'lp' | 'founder' | 'diligence' | 'vc' | 'internal' | 'travel' | 'event';

/** What a label's name has to say for each kind of event (any case, whole words). */
export const LABEL_WORDS: Readonly<Record<LabelCategory, RegExp>> = {
  portfolio: /\b(portfolio|port\s?cos?|portcos?|port\s?companies|portfolio\s+cos?)\b/i,
  lp: /\b(lps?|limited\s+partners?|investor\s+relations|ir|fund\s*(ii|iii|iv|2|3|4)|fundrais(e|ing))\b/i,
  founder: /\bfounders?\b/i,
  diligence: /\b(diligence|dd)\b/i,
  vc: /\b(vcs?|venture|ventures|co-?investors?|investors?)\b/i,
  internal: /\b(internal|team|staff)\b/i,
  travel: /\b(travel|travels|trips?|flights?)\b/i,
  event: /\b(events?|conferences?|meetups?)\b/i,
};

/** The calendar's labels whose names fit a kind of event. */
export function labelsFor(category: LabelCategory, labels: readonly EventLabel[]): EventLabel[] {
  return labels.filter((l) => {
    const name = l.name ?? '';
    if (!LABEL_WORDS[category].test(name)) return false;
    // "Investor relations" is about LPs, not other VCs.
    if (category === 'vc' && LABEL_WORDS.lp.test(name)) return false;
    return true;
  });
}

export interface LabelKnowledge {
  /** Nick's own domains (his team): never a free mailbox. */
  ownDomains: readonly string[];
  /** Portfolio companies by address and by domain: the company's name. */
  portfolioEmails: ReadonlyMap<string, string>;
  portfolioDomains: ReadonlyMap<string, string>;
  /** Deals in the pipeline by founder address and by domain: name and stage key. */
  dealEmails: ReadonlyMap<string, { name: string; stage: string }>;
  dealDomains: ReadonlyMap<string, { name: string; stage: string }>;
  /** LPs and Fund II prospects: addresses, names (lower case), firms (letters only, lower case). */
  lpEmails: ReadonlySet<string>;
  lpNames: ReadonlySet<string>;
  lpFirms: ReadonlySet<string>;
  /** Other VC firms by address and by domain: the firm's name (or the domain). */
  vcEmails: ReadonlyMap<string, string>;
  vcDomains: ReadonlyMap<string, string>;
}

export interface LabelSuggestion {
  labelId: string;
  name: string;
  /** Why, in plain words, for the card. */
  reason: string;
}

type Guest = { email: string; name: string | null };

const FREE_MAIL =
  /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|yahoo\.[a-z.]+|icloud\.com|me\.com|aol\.com|proton\.me|protonmail\.com)$/i;
const MACHINE =
  /^(calendar|invites?|invitations?|events?|rsvps?|tickets?|webinars?|no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|mailer[-_.]?daemon|hello|info)(\+[^@]*)?@/i;
const EVENT_PLATFORM =
  /@(.+\.)?(lu\.ma|luma\.com|luma-mail\.com|eventbrite\.[a-z.]+|partiful\.com|splashthat\.com|meetup\.com|cvent\.com)$/i;
const TRAVEL_TITLE =
  /\b(flight|flights|fly|flying|airport|red-?eye|train|hotel|check-?in|check-?out|travel|uber|lyft|rental car)\b/i;

const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? '';
/** `tickets.example.com` is `example.com`, for matching a company's domain. */
const siteOf = (domain: string) => domain.split('.').slice(-2).join('.');
const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function lookup<T>(map: ReadonlyMap<string, T>, email: string): T | undefined {
  const domain = domainOf(email);
  return map.get(email) ?? map.get(domain) ?? map.get(siteOf(domain));
}

const nameOf = (g: Guest) => g.name?.trim() || g.email;

type GuestKind =
  | { kind: 'internal' }
  | { kind: 'portfolio'; company: string }
  | { kind: 'deal'; company: string; stage: string }
  | { kind: 'lp' }
  | { kind: 'vc'; firm: string }
  | { kind: 'unknown' };

function classifyGuest(g: Guest, k: LabelKnowledge): GuestKind {
  const email = g.email.toLowerCase();
  const domain = domainOf(email);
  if (domain && !FREE_MAIL.test(domain) && k.ownDomains.includes(domain)) {
    return { kind: 'internal' };
  }
  const company = k.portfolioEmails.get(email) ?? lookup(k.portfolioDomains, email);
  if (company) return { kind: 'portfolio', company };
  const deal = k.dealEmails.get(email) ?? lookup(k.dealDomains, email);
  if (deal) return { kind: 'deal', company: deal.name, stage: deal.stage };
  const firmLabel = lettersOnly(domain.split('.').slice(-2, -1)[0] ?? '');
  if (
    k.lpEmails.has(email) ||
    (g.name && k.lpNames.has(g.name.trim().toLowerCase())) ||
    (firmLabel && k.lpFirms.has(firmLabel))
  ) {
    return { kind: 'lp' };
  }
  const firm = k.vcEmails.get(email) ?? lookup(k.vcDomains, email);
  if (firm) return { kind: 'vc', firm };
  return { kind: 'unknown' };
}

/** The people on it other than Nick: guests, and an organizer who is someone else. */
function otherPeople(
  event: Pick<RangeEvent, 'attendees' | 'organizer'>,
  ownEmails: readonly string[],
): Guest[] {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const people = new Map<string, Guest>();
  const add = (email: string, name: string | null) => {
    const e = email.toLowerCase();
    if (!e.includes('@') || own.has(e) || MACHINE.test(e) || EVENT_PLATFORM.test(e)) return;
    if (/calendar\.google\.com$/.test(e)) return;
    if (!people.has(e)) people.set(e, { email: e, name });
  };
  for (const a of event.attendees) {
    if (a.self || a.resource || a.response === 'declined') continue;
    add(a.email, a.name);
  }
  if (event.organizer && !event.organizer.self) add(event.organizer.email, event.organizer.name);
  return [...people.values()];
}

function pick(
  categories: readonly LabelCategory[],
  labels: readonly EventLabel[],
): EventLabel | null {
  for (const category of categories) {
    const fits = labelsFor(category, labels);
    if (fits.length === 1) return fits[0]!;
    // Two labels fit the same kind: unsure, so none.
    if (fits.length > 1) return null;
  }
  return null;
}

/**
 * The label to suggest for an event, or null: already labelled, a calendar
 * without labels, no clear sign, or no single label whose name fits.
 */
export function suggestLabel(
  event: Pick<
    RangeEvent,
    'labelId' | 'attendees' | 'organizer' | 'verdict' | 'eventType' | 'title'
  >,
  labels: readonly EventLabel[],
  knowledge: LabelKnowledge,
  ownEmails: readonly string[],
): LabelSuggestion | null {
  if (event.labelId || labels.length === 0) return null;
  const suggest = (label: EventLabel | null, reason: string): LabelSuggestion | null =>
    label ? { labelId: label.id, name: labelText(label), reason } : null;

  const people = otherPeople(event, ownEmails);
  const booking =
    event.eventType === 'fromGmail' || /^Booking from Gmail/.test(event.verdict.reason);
  if (booking || (people.length === 0 && TRAVEL_TITLE.test(event.title))) {
    return suggest(pick(['travel'], labels), 'It is a flight, a hotel or a booking.');
  }
  if (event.verdict.reason === 'An event registration, not a meeting') {
    return suggest(pick(['event'], labels), 'It is an event registration.');
  }
  if (people.length === 0) return null;

  const kinds = people.map((g) => ({ guest: g, k: classifyGuest(g, knowledge) }));
  const first = <K extends GuestKind['kind']>(kind: K) =>
    kinds.find((x) => x.k.kind === kind) as
      { guest: Guest; k: Extract<GuestKind, { kind: K }> } | undefined;

  const portfolio = first('portfolio');
  if (portfolio) {
    return suggest(
      pick(['portfolio'], labels),
      `${nameOf(portfolio.guest)} is at ${portfolio.k.company}, a portfolio company.`,
    );
  }
  const deal = first('deal');
  if (deal) {
    const diligence = deal.k.stage === 'diligence';
    return suggest(
      pick(diligence ? ['diligence', 'founder'] : ['founder', 'diligence'], labels),
      `${nameOf(deal.guest)} is at ${deal.k.company}, a deal in the pipeline${diligence ? ' in diligence' : ''}.`,
    );
  }
  const lp = first('lp');
  if (lp) {
    return suggest(pick(['lp'], labels), `${nameOf(lp.guest)} is an LP or a Fund II prospect.`);
  }
  const vc = first('vc');
  if (vc) {
    return suggest(
      pick(['vc'], labels),
      `${nameOf(vc.guest)} is at ${vc.k.firm}, another VC firm.`,
    );
  }
  if (kinds.every((x) => x.k.kind === 'internal')) {
    return suggest(pick(['internal'], labels), 'Only people from your own team are on it.');
  }
  return null;
}
