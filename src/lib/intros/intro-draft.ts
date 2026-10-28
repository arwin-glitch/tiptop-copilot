import { linkName, toLinkedInUrl } from '@/lib/email/name-links';
import { SIGN_OFF_NAME } from '@/lib/email/signatures';

/**
 * "Write the intro" on an owed intro: the email the partner reviews in the
 * compose window, built from the intro tracker's row and what Kraken
 * verifiably knows about the people in it. Pure, no server imports, for tests.
 *
 * The format is the fund's intro rule, not a model's prose:
 *  - A fresh thread, never a reply: the old thread may carry other people's
 *    context. Subject `Intro: First (Firm) <> First & First (Company)`, the
 *    person being asked first, then the people who asked for the intro.
 *  - Everyone is greeted by first name, and every co-founder is addressed.
 *  - Each person's full name is linked to their LinkedIn at the line that
 *    presents them, and only there; no other link, ever. A name with no
 *    LinkedIn on file stays plain.
 *  - The body ends at the sign-off. The real Gmail signature is added when
 *    it is sent, so none is typed here.
 *  - Recipients are only addresses verified data holds. A missing one is left
 *    out, with a hint to add it; nothing is guessed from a name.
 */

/** One person in an intro: their name and, only when verified data has them, address and LinkedIn. */
export interface IntroPerson {
  name: string;
  email: string | null;
  linkedin: string | null;
  /** On record as a founder of the side's company (a portfolio founder). */
  founder: boolean;
}

/** One side of an intro: who, and the firm or company they are at. */
export interface IntroSide {
  /** The tracker's own words for this side, as the card shows them. */
  label: string;
  org: string | null;
  /** Empty when only the firm is known, not who there. */
  people: IntroPerson[];
}

export interface IntroDraft {
  to: string;
  subject: string;
  body: string;
  /** What to check before sending: missing addresses, an unknown person, unlinked names. */
  hints: string[];
}

/** An owed intro's key on the card: the tracker repeats a pair at most once. */
export function introKey(intro: { for_who: string; to_who: string }): string {
  return `${intro.for_who} → ${intro.to_who}`;
}

/**
 * The tracker's text for one side, read as names and a firm: "Dana Lee
 * (Harbor Labs)", "Dana Lee & Omar Haddad (Harbor Labs)", "Dana Lee at Harbor
 * Labs". Text with no firm in it ("Harbor Labs", "Dana Lee") comes back as
 * one name, and `who` keeps it whole so the caller can see whether it is a
 * company before treating it as people.
 */
export function parseIntroSide(text: string): { who: string; names: string[]; org: string | null } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const paren = /^(.*?)\s*\(([^()]+)\)$/.exec(clean);
  const at = paren ? null : /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(clean);
  const who = (paren ? paren[1]! : at ? at[1]! : clean).trim();
  const org = (paren ? paren[2]! : at ? at[2]! : '').trim() || null;
  const names = who
    .split(/\s*(?:&|\+|\/|,|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
  return { who, names, org };
}

const COMPANY_WORD =
  /\b(?:labs?|capital|ventures?|vc|partners|fund|funds|group|holdings|inc|llc|ltd|corp|co|company|technologies|tech|systems|ai|bio|health|robotics|software|analytics|energy|logistics|foods|payroll|legal|office|foundation|endowment|studios?|network|collective|equity|investments?|advisors|management|hq)\b\.?$/i;

/**
 * For text no record recognises: whether it reads as a company or firm
 * rather than a person. One word ("Halyard") or a name ending in a company
 * word ("Harbor Labs") is a firm; anything else ("Dana Lee") a person.
 */
export function looksLikeCompany(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return !/\s/.test(clean) || COMPANY_WORD.test(clean);
}

const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|prof)\.?$/i;

/** The name to greet: the first word that is not an honorific. */
export function firstName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.find((w) => !HONORIFIC.test(w)) ?? words[0] ?? '';
}

/** "A", "A & B", "A, B & C" (or with "and"). */
export function joinNames(names: readonly string[], and: '&' | 'and' = '&'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`;
}

/** A side as the subject names it: first names and the firm, or the firm alone. */
function sideTitle(side: IntroSide): string {
  if (side.people.length === 0) return side.org ?? side.label;
  const firsts = joinNames(side.people.map((p) => firstName(p.name)));
  return side.org ? `${firsts} (${side.org})` : firsts;
}

/** `Intro: Hana (Riverlight) <> Maya & Theo (Ledgerly)`: the person asked first, then who asked. */
export function introSubject(target: IntroSide, founders: IntroSide): string {
  return `Intro: ${sideTitle(target)} <> ${sideTitle(founders)}`;
}

/** Who a side's line speaks to: first names, or the firm's team when nobody there is known. */
function addressed(side: IntroSide): string {
  if (side.people.length === 0) return `${side.org ?? side.label} team`;
  return joinNames(
    side.people.map((p) => firstName(p.name)),
    'and',
  );
}

/** A side presented to the other: full names (linked) and where they are. */
function presented(side: IntroSide): string {
  if (side.people.length === 0) return `the team at ${side.org ?? side.label}`;
  const names = joinNames(
    side.people.map((p) => linkName(p.name, p.linkedin)),
    'and',
  );
  if (!side.org) return names;
  if (side.people.every((p) => p.founder)) {
    return side.people.length > 1
      ? `${names}, co-founders at ${side.org}`
      : `${names}, founder of ${side.org}`;
  }
  return `${names} at ${side.org}`;
}

/**
 * The email in the fund's intro format. Each side is introduced to the other
 * in one line; both sides are greeted. Ends at the sign-off name: the compose
 * window's Sign as switch swaps the name, and the real signature is added on
 * send.
 */
export function introBody(target: IntroSide, founders: IntroSide): string {
  const known = [...target.people, ...founders.people];
  const someoneUnknown = target.people.length === 0 || founders.people.length === 0;
  const greeting = someoneUnknown ? 'all' : joinNames(known.map((p) => firstName(p.name)));
  const many = someoneUnknown || known.length > 2;
  return [
    `Hi ${greeting},`,
    '',
    `${addressed(target)} - meet ${presented(founders)}.`,
    '',
    `${addressed(founders)} - meet ${presented(target)}.`,
    '',
    many ? "I'll let you all take it from here!" : "I'll let you two take it from here!",
    '',
    'Cheers,',
    SIGN_OFF_NAME.nick,
  ].join('\n');
}

/** A display name safe inside an address header: no quotes, brackets or separators. */
function headerName(name: string): string {
  return name
    .replace(/[<>,;"\\\r\n()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ADDRESS =
  /^[a-z0-9][a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** A plain, valid address in lower case, or null. */
export function cleanEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  return email.length <= 254 && ADDRESS.test(email) ? email : null;
}

/** Everyone with a verified address, both sides, as `Name <address>`; one entry per address. */
export function introRecipients(target: IntroSide, founders: IntroSide): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...target.people, ...founders.people]) {
    const email = cleanEmail(p.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = headerName(p.name);
    out.push(name ? `${name} <${email}>` : email);
  }
  return out.join(', ');
}

/** What the compose window should say before anyone sends: plain sentences. */
export function introHints(target: IntroSide, founders: IntroSide): string[] {
  const hints: string[] = [];
  for (const side of [target, founders]) {
    if (side.people.length === 0) {
      hints.push(
        `Kraken doesn't know who at ${side.org ?? side.label} this goes to. Add their name in the email and their address in To.`,
      );
    }
  }
  const people = [...target.people, ...founders.people];
  const noEmail = people.filter((p) => !cleanEmail(p.email)).map((p) => p.name);
  if (noEmail.length > 0) {
    hints.push(
      `No email on file for ${joinNames(noEmail, 'and')}. Add ${noEmail.length > 1 ? 'theirs' : 'it'} to To before sending.`,
    );
  }
  const noLink = people.filter((p) => !toLinkedInUrl(p.linkedin)).map((p) => p.name);
  if (noLink.length > 0) {
    hints.push(
      `No LinkedIn on file for ${joinNames(noLink, 'and')}, so ${noLink.length > 1 ? 'those names stay' : 'that name stays'} unlinked.`,
    );
  }
  return hints;
}

/** The whole draft for the compose window. */
export function buildIntroDraft(target: IntroSide, founders: IntroSide): IntroDraft {
  return {
    to: introRecipients(target, founders),
    subject: introSubject(target, founders),
    body: introBody(target, founders),
    hints: introHints(target, founders),
  };
}
