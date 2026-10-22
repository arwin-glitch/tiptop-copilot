/**
 * "How you got here" when the guests say nothing: the email that put an
 * event on the calendar. Registrations, conference events, holds and
 * invitations from a list have no other guests (or hidden ones), so the
 * dossier note and the latest emails with the guests are always empty for
 * them. What is left to go on is the event itself: who organized it, the
 * sites its description and location link to (a ticketing site), and the
 * distinctive words of its title. This module turns an event into those
 * search terms and ranks what a search found. Pure: the reads are in
 * lib/services/calendar-origin.ts.
 */

export interface OriginEvent {
  title: string;
  organizer: { email: string; name?: string | null; self: boolean } | null;
  description: string | null;
  location: string | null;
  /** Timed: its start; all-day: its first day. */
  startsAt: string | null;
  startDate?: string | null;
}

export interface OriginTerms {
  /** The organizer's address, when it is someone else's (a person or a ticketing robot). */
  organizerEmail: string | null;
  /** Its domain, unless it is a free mailbox, a calendar id or Nick's own. */
  organizerDomain: string | null;
  /** The sites the description and location link to, video-call and Google links left out. */
  linkDomains: string[];
  /** The title's distinctive words: no dates, times, numbers or common words. */
  titleWords: string[];
  /** Those words as one phrase, for a search. */
  titlePhrase: string;
}

/** Mailboxes anyone can have: their domain says nothing about who sent it. */
const FREE_MAIL =
  /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|msn\.com|yahoo\.[a-z.]+|icloud\.com|me\.com|mac\.com|aol\.com|proton\.me|protonmail\.com|fastmail\.com|hey\.com)$/i;

/** Calendar ids and the like: not a sender. */
const NOT_A_SENDER = /(^|\.)(calendar\.google\.com|resource\.calendar\.google\.com)$/i;

/** Links every invite carries: a video call, Google's own pages, a map, a link shortener. */
const GENERIC_LINK =
  /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co|zoom\.us|zoom\.com|teams\.microsoft\.com|microsoft\.com|office\.com|live\.com|webex\.com|whereby\.com|around\.co|bit\.ly|tinyurl\.com|aka\.ms|apple\.com|youtube\.com|youtu\.be)$/i;

/** Words that say nothing about which event it is. */
const COMMON = new Set(
  (
    'the a an and or of for to in on at by with w from into via per vs x ' +
    'call meeting meet sync chat catch up catchup check checkin intro hold tentative tbd ' +
    'placeholder block busy event events session invite invitation updated accepted ' +
    'declined new re fwd fw am pm today tomorrow week weekly daily monthly quarterly ' +
    'annual day night morning afternoon evening time zoom google teams virtual online ' +
    'in-person irl please rsvp join our your you we us my me nick'
  ).split(' '),
);

const MONTHS =
  /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/;
const WEEKDAYS =
  /^(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)$/;

/** `tickets.example.co.uk` is `example.co.uk`; `www.example.com` is `example.com`. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const second = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  const take = tld.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(second) ? 3 : 2;
  return parts.slice(-take).join('.');
}

const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? '';

/** The distinctive words of a title, longest first, at most four. */
export function distinctiveWords(title: string): string[] {
  const words = title
    .replace(/[“”"'’()[\]{}:;,.!?|/\\<>@#*+=~^_–—-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .filter((w) => !/\d/.test(w))
    .filter((w) => {
      const lower = w.toLowerCase();
      return !COMMON.has(lower) && !MONTHS.test(lower) && !WEEKDAYS.test(lower);
    });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  // Keep the title's order for the phrase; at most four.
  return out.slice(0, 4);
}

const LINK = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s"'<>)]*)?/gi;

/** What to search for an event: its organizer, the sites it links to, its title's words. */
export function originTerms(event: OriginEvent, ownEmails: readonly string[]): OriginTerms {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const ownDomains = new Set([...own].map(domainOf).filter(Boolean));
  const organizer = event.organizer;
  const organizerEmail =
    organizer && !organizer.self && organizer.email && !own.has(organizer.email.toLowerCase())
      ? organizer.email.toLowerCase()
      : null;
  const orgDomain = organizerEmail ? domainOf(organizerEmail) : '';
  const organizerDomain =
    orgDomain &&
    !FREE_MAIL.test(orgDomain) &&
    !NOT_A_SENDER.test(orgDomain) &&
    !ownDomains.has(orgDomain)
      ? siteOf(orgDomain)
      : null;
  const linkDomains: string[] = [];
  const text = `${event.location ?? ''} ${event.description ?? ''}`;
  for (const match of text.matchAll(LINK)) {
    const host = match[1]!.toLowerCase();
    if (GENERIC_LINK.test(host)) continue;
    const site = siteOf(host);
    if (ownDomains.has(site) || linkDomains.includes(site)) continue;
    linkDomains.push(site);
    if (linkDomains.length >= 2) break;
  }
  const titleWords = distinctiveWords(event.title === '(no title)' ? '' : event.title);
  return {
    organizerEmail: organizerEmail && !NOT_A_SENDER.test(orgDomain) ? organizerEmail : null,
    organizerDomain,
    linkDomains,
    titleWords,
    titlePhrase: titleWords.join(' '),
  };
}

/** Something a search found that may be what put the event on the calendar. */
export interface OriginCandidate {
  kind: 'email' | 'note' | 'event';
  /** An email's link id (Gmail's or a synced email's), a note's id, an event's id. */
  id: string;
  /** Subject, note title or event title. */
  title: string;
  /** Who sent it, as a name to show. */
  from: string | null;
  fromAddress: string | null;
  at: string | null;
  /** Its preview text, when there is one: a ticket link is often only there. */
  snippet?: string | null;
}

export type OriginKind = 'registration' | 'invitation' | 'email' | 'note' | 'event';

export interface RankedOrigin {
  candidate: OriginCandidate;
  kind: OriginKind;
  score: number;
}

/** Google Calendar's own mails: invitations, updates and answers. */
const INVITATION = /^\s*(invitation|updated invitation|new event|updated event)\b.*:/i;
/** Words a sign-up or a booking confirmation uses. */
const REGISTRATION =
  /\b(ticket|tickets|registration|registered|register|confirmed|confirmation|you['’]re in|you are in|rsvp|rsvp['’]d|order|booking|booked|reservation|itinerary|e-?ticket|admission|pass)\b/i;

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );

/** How many of the title's words a text has. */
function titleHits(text: string, titleWords: readonly string[]): number {
  const have = words(text);
  return titleWords.filter((w) => have.has(w.toLowerCase())).length;
}

/** The least a candidate must score to be shown: a title word alone is not enough. */
export const ORIGIN_MIN_SCORE = 4;

/**
 * Rank what the searches found, best first, at most `limit`: an email from
 * the organizer or from a site the event links to, or one about the title,
 * before the event; Google's invitation for it; a meeting note or an earlier
 * event with the same title. Below ORIGIN_MIN_SCORE nothing is shown.
 */
export function rankOrigins(
  candidates: readonly OriginCandidate[],
  terms: OriginTerms,
  event: Pick<OriginEvent, 'startsAt' | 'startDate'>,
  limit = 3,
): RankedOrigin[] {
  const start = Date.parse(
    event.startsAt ?? (event.startDate ? `${event.startDate}T00:00:00Z` : ''),
  );
  const need = terms.titleWords.length;
  const seen = new Set<string>();
  const ranked: RankedOrigin[] = [];
  for (const c of candidates) {
    const key = `${c.kind}|${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hits = titleHits(`${c.title}`, terms.titleWords);
    if (c.kind !== 'email') {
      // A note or an earlier event counts only with (nearly) the same title.
      if (need === 0 || hits < Math.max(1, Math.ceil(need * 0.75))) continue;
      if (c.kind === 'event' && Number.isFinite(start) && c.at && Date.parse(c.at) >= start) {
        continue;
      }
      ranked.push({ candidate: c, kind: c.kind, score: 4 + hits });
      continue;
    }
    const address = (c.fromAddress ?? '').toLowerCase();
    const site = address.includes('@') ? siteOf(domainOf(address)) : '';
    const body = `${c.title} ${c.snippet ?? ''}`.toLowerCase();
    let score = 0;
    if (terms.organizerEmail && address === terms.organizerEmail) score += 5;
    else if (terms.organizerDomain && site === terms.organizerDomain) score += 4;
    if (terms.linkDomains.includes(site)) score += 4;
    else if (terms.linkDomains.some((d) => body.includes(d))) score += 2;
    score += Math.min(6, hits * 2);
    if (need > 0 && hits >= Math.ceil(need * 0.75)) score += 2;
    const invitation = INVITATION.test(c.title) && hits > 0;
    if (invitation) score += 3;
    const registration = !invitation && REGISTRATION.test(c.title);
    if (registration && score > 0) score += 2;
    // What put it on the calendar came before it.
    if (Number.isFinite(start) && c.at && Date.parse(c.at) > start) score -= 3;
    if (score < ORIGIN_MIN_SCORE) continue;
    ranked.push({
      candidate: c,
      kind: invitation ? 'invitation' : registration ? 'registration' : 'email',
      score,
    });
  }
  const order = (r: RankedOrigin) => (r.kind === 'note' || r.kind === 'event' ? 1 : 0);
  return ranked
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        b.score - a.score ||
        (b.candidate.at ?? '').localeCompare(a.candidate.at ?? ''),
    )
    .slice(0, limit);
}

/** "Oct 3", for a line. */
function shortDate(iso: string | null, timeZone: string): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

/** One found line in plain words: "Registration email from Harborlight Events, Oct 17". */
export function originLineText(origin: RankedOrigin, timeZone: string): string {
  const { candidate: c } = origin;
  const when = shortDate(c.at, timeZone);
  const from = c.from?.trim() || c.fromAddress || null;
  const tail = when ? `, ${when}` : '';
  switch (origin.kind) {
    case 'registration':
      return `Registration email${from ? ` from ${from}` : ''}${tail}`;
    case 'invitation':
      return `The invitation${from ? ` from ${from}` : ''}${tail}`;
    case 'email':
      return `Email${from ? ` from ${from}` : ''}: “${c.title}”${tail}`;
    case 'note':
      return `Meeting note “${c.title}”${tail}`;
    case 'event':
      return `On the calendar before as “${c.title}”${tail}`;
  }
}

/** What was looked for, in plain words, when nothing turned up. */
export function checkedWords(terms: OriginTerms, guests: number): string {
  const parts = [
    'a dossier note',
    guests > 0 ? 'emails with the guests' : null,
    terms.organizerDomain
      ? `email from ${terms.organizerDomain}`
      : terms.organizerEmail
        ? `email from ${terms.organizerEmail}`
        : null,
    terms.linkDomains.length ? `email mentioning ${terms.linkDomains.join(' or ')}` : null,
    terms.titlePhrase ? `email about “${terms.titlePhrase}”` : null,
    terms.titlePhrase ? 'a meeting note or an earlier event with this title' : null,
  ].filter((p): p is string => p !== null);
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  return `Copilot looked for ${list}, and found nothing that explains it.`;
}

/** The Inbox search for an event: its distinctive words, else its title. */
export function inboxSearchFor(terms: OriginTerms, title: string): { query: string; href: string } {
  const query = (terms.titlePhrase || title).trim().slice(0, 120);
  return { query, href: `/inbox?q=${encodeURIComponent(query)}` };
}
