import {
  HELP_PAGES,
  HELP_SECTIONS,
  tourHref,
  type HelpPage,
  type HelpSection,
} from '@/lib/help/registry';
import { TOUR_PARAM } from '@/lib/help/tour-ids';
import type { Citation } from '@/lib/types/domain';

/**
 * Ask Arwin's map of Kraken: "where is…", "how do I…" questions answered
 * from the Help registry, the same data the /help cards and the guided tours
 * draw from. Nothing here lists pages by hand: every page, tab and tour step
 * is read from `lib/help/registry.ts`, so a new page or tab is findable the
 * moment it has a Help entry. The only hand-written part is a short list of
 * everyday words for things (SYNONYMS), and a unit test checks each one still
 * points at a real entry.
 *
 * Pure: no React, no server-only imports. The Ask service uses it for instant
 * answers, the model's `app_guide_search` tool and the bridge routine's
 * payload all read the same matches.
 */

/** One place in Kraken a question can be sent to: a page, a tab, or the Ask widget. */
export interface AppGuideEntry {
  /** `today`, `tasks:snoozed`, or a Help section id such as `jobs`. */
  id: string;
  /** The page it sits on (its Help id): tabs and sections share their page's group. */
  group: string;
  /** "Tasks" or "Tasks › Snoozed". */
  title: string;
  pageName: string;
  /** The tab's own label, for a tab or a section. */
  tabLabel: string | null;
  /** Opens it; null only when there is nothing to open (never for a page). */
  href: string | null;
  /** The tour "Show me" starts (a page or section id), when there is one. */
  tourId: string | null;
  /** Opens the page and starts that tour. */
  tourHref: string | null;
  /** One plain line on what it holds. */
  summary: string;
  /** Searchable text, each with its weight. */
  fields: GuideField[];
}

/** Searchable text and its weight. A name is matched but never quoted as the reason. */
export interface GuideField {
  text: string;
  weight: number;
  name?: true;
  /** What to quote when this field matches, when not the text itself (a step's body). */
  why?: string;
}

export interface AppGuideMatch {
  id: string;
  group: string;
  title: string;
  pageName: string;
  tabLabel: string | null;
  href: string | null;
  tourId: string | null;
  tourHref: string | null;
  /** The text that matched best: a tab's blurb, a tour step, or the page's purpose. */
  why: string;
  score: number;
  /**
   * Named outright: its own page, tab or Help card name said in the question,
   * or a strong synonym. A match that is only a hint (words from its blurb, a
   * weak synonym such as "email") is not strong.
   */
  strong?: boolean;
}

/* ------------------------------------------------------------- synonyms */

/**
 * Words people use for things, mapped to the entry they mean. Only words the
 * registry itself does not already carry; each target must be a real entry
 * id (pinned by tests/unit/app-guide.test.ts).
 *
 * A strong synonym is a word for the app itself (snooze, booking link, job
 * board) and names its entry outright. A weak one is an everyday word people
 * mostly use about their own mail and deals ("email", "wire", "intro"): it
 * nudges the ranking but never makes an answer confident on its own.
 */
export const SYNONYMS: readonly { phrase: string; target: string; weak?: true }[] = [
  { phrase: 'snooze', target: 'tasks:snoozed' },
  { phrase: 'put off', target: 'tasks:snoozed' },
  { phrase: 'todo', target: 'tasks' },
  { phrase: 'reminder', target: 'tasks', weak: true },
  { phrase: 'wire', target: 'tasks:money', weak: true },
  { phrase: 'invoice', target: 'tasks:money', weak: true },
  { phrase: 'booking link', target: 'booking' },
  { phrase: 'calendly', target: 'booking' },
  { phrase: 'scheduling link', target: 'booking' },
  { phrase: 'booking request', target: 'booking:bookings' },
  { phrase: 'availability', target: 'booking:availability' },
  { phrase: 'pick times', target: 'booking:availability' },
  { phrase: 'open months', target: 'booking:availability' },
  { phrase: 'chatbot', target: 'booking-chatbot' },
  { phrase: 'job board', target: 'jobs' },
  { phrase: 'open roles', target: 'jobs' },
  { phrase: 'hiring', target: 'jobs', weak: true },
  { phrase: 'intern', target: 'students' },
  { phrase: 'intro', target: 'network:intros', weak: true },
  { phrase: 'introduction', target: 'network:intros', weak: true },
  { phrase: 'alert', target: 'settings:preferences' },
  { phrase: 'notification', target: 'settings:preferences' },
  { phrase: 'phone alert', target: 'settings:preferences' },
  { phrase: 'time zone', target: 'settings:preferences' },
  { phrase: 'thesis', target: 'settings' },
  { phrase: 'connect', target: 'settings:integrations' },
  { phrase: 'gmail', target: 'inbox', weak: true },
  { phrase: 'email', target: 'inbox', weak: true },
  { phrase: 'compose', target: 'inbox' },
  { phrase: 'docsend', target: 'fund-ii:readers' },
  { phrase: 'deck reader', target: 'fund-ii:readers' },
  { phrase: 'opened the deck', target: 'fund-ii:readers' },
  { phrase: 'read the deck', target: 'fund-ii:readers' },
  { phrase: 'lp', target: 'fund-ii', weak: true },
  { phrase: 'meeting note', target: 'meetings:notes' },
  { phrase: 'recap', target: 'follow-ups', weak: true },
  { phrase: 'followups', target: 'follow-ups' },
  { phrase: 'waiting on', target: 'follow-ups', weak: true },
  { phrase: 'rsvp', target: 'events', weak: true },
  { phrase: 'guest list', target: 'events' },
  { phrase: 'event page', target: 'events' },
  { phrase: 'desktop app', target: 'download' },
  { phrase: 'mac app', target: 'download' },
  { phrase: 'install', target: 'download' },
  { phrase: 'dealflow', target: 'reports', weak: true },
  { phrase: 'digest', target: 'reports', weak: true },
  { phrase: 'kpi', target: 'portfolio:numbers', weak: true },
  { phrase: 'metrics', target: 'portfolio:numbers', weak: true },
  { phrase: 'feedback', target: 'ask:feedback', weak: true },
  { phrase: 'pitch', target: 'deals', weak: true },
  { phrase: 'tour', target: 'help' },
  { phrase: 'guide', target: 'help' },
];

/* --------------------------------------------------------------- tokens */

/** Words that say nothing about where something is. */
const STOP = new Set(
  (
    'a an and are as at be can could did do does doing find for from get go going how i if in ' +
    'into is it its kraken me my of on or page pages please screen section see set should show ' +
    'tab tabs that the there this to up use used using want we what whats where wheres which who ' +
    'why will with would you your app button menu thing stuff look open view some any all one ' +
    'way work'
  ).split(' '),
);

/** A light stemmer: enough that snooze, snoozed and snoozing meet. */
function stem(word: string): string {
  let w = word.replace(/'s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/'(?!s\b)/g, '')
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** The stemmed words of `text` that carry meaning. */
export function tokens(text: string): string[] {
  return words(text)
    .filter((w) => !STOP.has(w.replace(/'s$/, '')))
    .map(stem)
    .filter((w) => w.length >= 2);
}

/* ---------------------------------------------------------------- index */

function tourIdFor(page: HelpPage): string | null {
  return page.steps.length > 0 ? page.id : null;
}

/** A tour step's title and body; a title match quotes the body, which says more. */
function stepFields(page: HelpPage): GuideField[] {
  return page.steps.flatMap((s) => [
    { text: s.title, weight: 3, why: s.body },
    { text: s.body, weight: 1 },
  ]);
}

function pageEntry(page: HelpPage): AppGuideEntry {
  const tourId = tourIdFor(page);
  return {
    id: page.id,
    group: page.id,
    title: page.name,
    pageName: page.name,
    tabLabel: null,
    // The Ask widget has no page of its own; its Help card stands in.
    href: page.href ?? `/help#help-${page.id}`,
    tourId,
    tourHref: tourId ? tourHref(page) : null,
    summary: page.purpose,
    fields: [
      { text: page.name, weight: 8, name: true },
      { text: page.purpose, weight: 2 },
      ...stepFields(page),
    ],
  };
}

function sectionEntry(section: HelpSection, page: HelpPage | undefined): AppGuideEntry {
  const tab = page?.subtabs.find((t) => t.key === section.tab);
  const tabLabel = tab?.label ?? section.name;
  const pageName = page?.name ?? section.name;
  return {
    id: section.id,
    group: section.parent,
    title: `${pageName} › ${tabLabel}`,
    pageName,
    tabLabel,
    href: section.href,
    tourId: section.steps.length > 0 ? section.id : null,
    tourHref: section.steps.length > 0 ? tourHref(section) : null,
    summary: tab?.blurb ?? section.purpose,
    fields: [
      { text: section.name, weight: 6, name: true },
      { text: tabLabel, weight: 6, name: true },
      { text: pageName, weight: 3, name: true },
      { text: section.purpose, weight: 2 },
      ...(tab ? [{ text: tab.blurb, weight: 3 }] : []),
      ...stepFields(section),
    ],
  };
}

function pathOf(href: string): string {
  return href.split(/[?#]/)[0] ?? href;
}

/**
 * "Show me" for a tab: the tour of the page the tab's link opens, started on
 * that tab, so the reader stays where the answer sent them. A tab that links
 * to another page (Settings › Booking link opens Booking) gets that page's
 * tour, or none.
 */
function tabTour(href: string, page: HelpPage): { tourId: string | null; tourHref: string | null } {
  const owner =
    page.href && pathOf(href) === pathOf(page.href)
      ? page
      : HELP_PAGES.find((p) => p.href !== null && pathOf(p.href) === pathOf(href));
  const tourId = owner ? tourIdFor(owner) : null;
  if (!tourId) return { tourId: null, tourHref: null };
  const [base = href, hash] = href.split('#');
  const link = `${base}${base.includes('?') ? '&' : '?'}${TOUR_PARAM}=${encodeURIComponent(tourId)}`;
  return { tourId, tourHref: hash ? `${link}#${hash}` : link };
}

const HELP_SUMMARY = 'Help explains every page and starts a guided tour of any of them.';

/**
 * Help itself, so "where is Help?" has an answer. It has no registry entry
 * (it is the page that reads the registry), so it is the one entry made here.
 */
const HELP_ENTRY: AppGuideEntry = {
  id: 'help',
  group: 'help',
  title: 'Help',
  pageName: 'Help',
  tabLabel: null,
  href: '/help',
  tourId: null,
  tourHref: null,
  summary: HELP_SUMMARY,
  fields: [
    { text: 'Help', weight: 8, name: true },
    { text: HELP_SUMMARY, weight: 2 },
  ],
};

function buildIndex(): AppGuideEntry[] {
  const entries: AppGuideEntry[] = [];
  for (const page of HELP_PAGES) {
    entries.push(pageEntry(page));
    const pageTour = tourIdFor(page);
    for (const tab of page.subtabs) {
      // A tab with its own Help section is indexed once, as that section.
      if (HELP_SECTIONS.some((s) => s.parent === page.id && s.tab === tab.key)) continue;
      const tour = tab.href
        ? tabTour(tab.href, page)
        : { tourId: pageTour, tourHref: pageTour ? tourHref(page) : null };
      entries.push({
        id: `${page.id}:${tab.key}`,
        group: page.id,
        title: `${page.name} › ${tab.label}`,
        pageName: page.name,
        tabLabel: tab.label,
        href: tab.href ?? page.href ?? `/help#help-${page.id}`,
        tourId: tour.tourId,
        tourHref: tour.tourHref,
        summary: tab.blurb,
        fields: [
          { text: tab.label, weight: 6, name: true },
          { text: page.name, weight: 3, name: true },
          { text: tab.blurb, weight: 3 },
        ],
      });
    }
  }
  for (const section of HELP_SECTIONS) {
    entries.push(
      sectionEntry(
        section,
        HELP_PAGES.find((p) => p.id === section.parent),
      ),
    );
  }
  entries.push(HELP_ENTRY);
  return entries;
}

let cached: AppGuideEntry[] | null = null;

/** Every page, tab and Help section, read from the registry once. */
export function appGuideIndex(): readonly AppGuideEntry[] {
  cached ??= buildIndex();
  return cached;
}

export function appGuideEntry(id: string): AppGuideEntry | undefined {
  return appGuideIndex().find((e) => e.id === id);
}

/* --------------------------------------------------------------- search */

/** How much a name or tab label hit is worth; below this a match is only a hint. */
export const MIN_CONFIDENT_SCORE = 6;
const SYNONYM_WEIGHT = 10;
/** An everyday word ("email", "wire"): under the confident line on its own. */
const WEAK_SYNONYM_WEIGHT = 3;
/** Saying a tab's name in full; a page's name counts for more, so "Calendar" is the page, not Booking's Calendars tab. */
const EXACT_TAB_BONUS = 4;
const EXACT_PAGE_BONUS = 6;

function contains(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/** The words of `text` that carry meaning, unstemmed: "bookings" stays apart from "booking". */
function plainWords(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w.replace(/'s$/, '')));
}

const synonymTokenCache = new Map<string, string[]>();
function synonymTokensFor(entry: AppGuideEntry): string[] {
  let cachedTokens = synonymTokenCache.get(entry.id);
  if (!cachedTokens) {
    cachedTokens = SYNONYMS.filter(
      (s) => s.target === entry.id || s.target === entry.group,
    ).flatMap((s) => tokens(s.phrase));
    synonymTokenCache.set(entry.id, cachedTokens);
  }
  return cachedTokens;
}

interface Scored {
  entry: AppGuideEntry;
  score: number;
  why: string;
  /** Its own name said (stems match). */
  said: boolean;
  /** Its own name said word for word. */
  exact: boolean;
  strong: boolean;
  /** Question words it matched beyond its own name. */
  extra: number;
}

function scoreEntry(
  entry: AppGuideEntry,
  queryTokens: string[],
  queryPlain: string[],
  synonyms: { strong: Set<string>; weak: Set<string> },
): Scored {
  let score = 0;
  const fieldTokens = entry.fields.map((f) => ({ ...f, tokens: new Set(tokens(f.text)) }));
  // Its names, and the synonyms that stand for it ("email" for Inbox): saying
  // them is how the question found it, not a reason to quote a step.
  const nameTokens = new Set([
    ...fieldTokens.filter((f) => f.name).flatMap((f) => [...f.tokens]),
    ...synonymTokensFor(entry),
  ]);

  for (const token of new Set(queryTokens)) {
    let best = 0;
    for (const f of fieldTokens) if (f.tokens.has(token) && f.weight > best) best = f.weight;
    score += best;
  }
  // Its own name said in full ("fund ii", "booking assistant"): a page's
  // name, or a tab's label or Help card name. Not the parent page's name.
  const ownNames = entry.fields.filter((f) => f.name && f.weight >= 6);
  const said = ownNames.some((f) => contains(queryTokens, tokens(f.text)));
  const exact = ownNames.some((f) => contains(queryPlain, plainWords(f.text)));
  if (said) score += entry.tabLabel ? EXACT_TAB_BONUS : EXACT_PAGE_BONUS;
  if (synonyms.strong.has(entry.id)) score += SYNONYM_WEIGHT;
  else if (synonyms.weak.has(entry.id)) score += WEAK_SYNONYM_WEIGHT;

  // The "why": descriptive text (not a name) that matched something the
  // name does not already say. A step body sharing one word ("deal") with
  // the question reads as a different answer, so it needs two; a tab's blurb
  // or a step's title needs one.
  const beyondName = [...new Set(queryTokens)].filter((t) => !nameTokens.has(t));
  let bestField: { why: string; rank: number } | null = null;
  let extra = 0;
  for (const f of fieldTokens) {
    if (f.name) continue;
    const hits = beyondName.filter((t) => f.tokens.has(t)).length;
    extra = Math.max(extra, hits);
    if (hits === 0 || (hits < 2 && f.weight < 3)) continue;
    const rank = hits * f.weight;
    if (!bestField || rank > bestField.rank) bestField = { why: f.why ?? f.text, rank };
  }
  return {
    entry,
    score,
    why: bestField?.why ?? entry.summary,
    said,
    exact,
    strong: said || synonyms.strong.has(entry.id),
    extra,
  };
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * A page beats its own tab when the tab's label is the page's name with an
 * "s" ("Booking" and its "Bookings" tab stem the same). Hand the win to the
 * tab when its label was said word for word and the page's name was not, or
 * when the tab matched more of the question than the page did.
 */
function preferNamesakeTab(scored: Scored[]): void {
  const top = scored[0];
  if (!top || top.entry.tabLabel !== null) return;
  const pageName = tokens(top.entry.pageName);
  const index = scored.findIndex(
    (s) =>
      s.entry.group === top.entry.group &&
      s.entry.tabLabel !== null &&
      s.said &&
      sameWords(tokens(s.entry.tabLabel), pageName) &&
      ((s.exact && !top.exact) || s.extra > top.extra),
  );
  if (index <= 0) return;
  const [tab] = scored.splice(index, 1);
  scored.unshift({ ...tab!, score: Math.max(tab!.score, top.score + 1) });
}

/**
 * The places in Kraken a question points at, best first. Empty when nothing
 * matches at all.
 */
export function searchAppGuide(
  question: string,
  options: { limit?: number } = {},
): AppGuideMatch[] {
  const limit = options.limit ?? 5;
  const queryTokens = tokens(question);
  if (queryTokens.length === 0) return [];
  const queryPlain = plainWords(question);
  const hit = SYNONYMS.filter((s) => contains(queryTokens, tokens(s.phrase)));
  const synonyms = {
    strong: new Set(hit.filter((s) => !s.weak).map((s) => s.target)),
    weak: new Set(hit.filter((s) => s.weak).map((s) => s.target)),
  };

  const scored = appGuideIndex()
    .map((entry) => scoreEntry(entry, queryTokens, queryPlain, synonyms))
    .filter((s) => s.score > 0)
    // Best first; on a tie the more specific place (a tab) wins over its page.
    .sort(
      (a, b) =>
        b.score - a.score || Number(b.entry.tabLabel !== null) - Number(a.entry.tabLabel !== null),
    );
  preferNamesakeTab(scored);

  return scored.slice(0, limit).map(({ entry, score, why, strong }) => ({
    id: entry.id,
    group: entry.group,
    title: entry.title,
    pageName: entry.pageName,
    tabLabel: entry.tabLabel,
    href: entry.href,
    tourId: entry.tourId,
    tourHref: entry.tourHref,
    why: why.length > 0 ? why : entry.summary,
    score,
    strong,
  }));
}

/**
 * The verdict on a question's matches: one place (confident), a short list
 * of places to choose from (ambiguous), or nothing worth answering with.
 */
export type AppGuideVerdict =
  | { kind: 'confident'; match: AppGuideMatch }
  | { kind: 'ambiguous'; matches: AppGuideMatch[] }
  | { kind: 'none' };

export function judgeMatches(matches: readonly AppGuideMatch[]): AppGuideVerdict {
  const top = matches[0];
  if (!top || top.score < MIN_CONFIDENT_SCORE) return { kind: 'none' };
  // Only another page competes: a page and its own tab agree on where to go.
  const rivals = matches.filter((m) => m.group !== top.group);
  const rival = rivals[0];
  if (!rival || rival.score < top.score * 0.75) return { kind: 'confident', match: top };
  const choices: AppGuideMatch[] = [top];
  for (const m of rivals) {
    if (choices.length >= 3) break;
    if (m.score >= top.score * 0.6 && !choices.some((c) => c.group === m.group)) choices.push(m);
  }
  // A list is offered only when every place on it was named outright and the
  // question said a lot: two weak hints are more often a question about data.
  if (top.score < MIN_CONFIDENT_SCORE * 2 || !choices.every((c) => c.strong)) {
    return { kind: 'none' };
  }
  return { kind: 'ambiguous', matches: choices };
}

/* ------------------------------------------------------ question shape */

/** Things done on a page: "how do I snooze…", "how to import…". Not advice ("reply", "reach"). */
const NAV_VERB =
  '(find|get to|go to|open|see|view|turn on|turn off|turn|switch|set up|setup|set|change|use|' +
  'add|create|make|snooze|unsnooze|filter|search|sort|install|enable|disable|import|export|' +
  'connect|give|leave|archive|star|edit|share|replay|start|hide|pin|upload|download|move|' +
  'rename|access|book|schedule|update)';

const HOW_DO_I_VERB = new RegExp(`^how (?:(?:do|can) i|to) ${NAV_VERB}\\b(.*)$`);

/** "Where is…", "how do I…", "which tab…": asking about Kraken itself. */
const NAVIGATION = [
  /^(where|wheres|where's)\b/,
  HOW_DO_I_VERB,
  /\bwhich (page|tab|screen|section|menu|button)\b/,
  /\bwhat (does|do|is) (the |a |my )?[\w &'-]+ (tab|page|screen|section|button)( do| for| hold| show)?\b/,
  /\bwhat('s| is) on the [\w &'-]+ (tab|page)\b/,
  /^(find|open|take me to|go to|show me) the [\w &'-]+ (page|tab|section|settings|button|screen)\b/,
  /^(take me to|go to)\b/,
  /\bhow (does|do) (the )?[\w &'-]+ (tab|page|work)\b/,
  /\bhow to use\b/,
  /\b(in|on) (kraken|the app)\b/,
  /\bwhere (can|do|would|should) (i|we) (find|see|go|look)\b/,
  /^is there (a|an) ([\w &'-]+ )?(page|tab|setting|button|place)\b/,
];

const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

/** Questions about Nick's data, which only the full answer can handle. */
const DATA = [
  /\bhow (is|are|was|were) [\w &'-]+ doing\b/,
  /^how (many|much|often|long)\b/,
  /\bwhat did\b/,
  /\bwho (is|are|was|were|said|sent|asked|owes|wrote)\b/,
  /\bwhen (is|are|was|did|does|do|will)\b/,
  /\bwhen's\b/,
  /\bsummari[sz]e\b/,
  /\b(did|has|have) [\w'-]+ (reply|replied|respond|responded|answer|answered|send|sent)\b/,
  /\bwhat('s| is) (my|our) (next|first|last)\b/,
  /\bwhere(?: is| are| was|'s) (my|the|our) (next |first |last )?(meeting|call|dinner|lunch|coffee|breakfast|event|flight|offsite|agm)s?\b(?! (notes?|page|tab)\b)/,
  // "Where is Riley based", but not "where is the today page".
  /\bwhere(?: is| are| was|'s) (?!(?:the|my|our|a|an)\b)[\w'-]+ (based|from|located|now|today)\b(?! (page|tab)\b)/,
  /\bwhere (did|does|do) [\w'-]+ (go|work|live|study|stand)\b/,
  // Status: "where are we on the wire", "where do things stand".
  /\bwhere (are|am|do|did|does|is) (we|i|things|it|they) (on|with|at|stand)\b/,
  // Money moving is a status question, not a place: "where is the wire".
  /\bwhere(?: is| are|'s) (the |my |our )?(money|wires?|funds|payments?|cheques?|checks?)\b/,
  // Advice, or asking Arwin to act: "how should I reply to…", "how can we improve…".
  /\bhow (?:(?:do|can|should|would|could) (?:i|we)|to) (reply|respond|answer|say|tell|write|word|handle|deal with|reach|contact|approach|help|improve|pitch|negotiate|follow up|thank|ask|convince|introduce|decline|pass on|push back|connect with|get (?:a |an |the )?(?:meeting|money|intro|call|reply|response))\b/,
  // A time means their own notes or meetings: "my notes from yesterday".
  new RegExp(
    `\\b(yesterday|yesterday's|today's|tonight|tonight's|tomorrow|tomorrow's|earlier today|` +
      `this (morning|afternoon|evening|week|month|year)|last (week|night|month|year|time)|` +
      `next (week|month)|(from|on|last|this|next) ${WEEKDAY})\\b`,
  ),
];

/** Words that are fine capitalized mid-question (names of things, not people). */
const KNOWN_CAPITALS = new Set(
  'i kraken arwin gmail google slack affinity docsend lp lps mac windows pc iphone claude tiptop ok calendly kpi kpis'.split(
    ' ',
  ),
);

/** Words about the app in general, fine after "for", "from" or a verb. */
const GENERIC_UI = new Set(
  (
    'page tab setting settings button link links board card cards menu screen section mode theme ' +
    'filter filters list lists phone desktop dark light key keys keyboard shortcut shortcuts date ' +
    'dates time times new tour tours help everything something anything'
  ).split(' '),
);

/** Skipped when looking at the word after "for", "from" or a verb. */
const DETERMINERS = new Set(
  'the my our a an this that your these those all any some each every new'.split(' '),
);

/** After "from", "for" or "with", a pronoun means someone already being talked about. */
const PRONOUNS = new Set('him her them his their he she they it its'.split(' '));

/** People Kraken has pages for; "the feedback from the founders" is still about people. */
const PEOPLE = new Set(
  'founder founders investor investors operator operators people person contacts contact students student lp lps team providers provider'.split(
    ' ',
  ),
);
const FROM_PEOPLE = new Set('from by about with regarding re'.split(' '));

/** Prepositions that, followed by a name, make it a question about someone's data. */
const TAIL_PREPS = new Set('from for about with by at of to regarding re'.split(' '));

let vocabulary: { plain: Set<string>; stems: Set<string> } | null = null;
function appVocabulary(): { plain: Set<string>; stems: Set<string> } {
  if (vocabulary) return vocabulary;
  const plain = new Set(KNOWN_CAPITALS);
  // Names only: tour copy quotes examples ("from:jane") that are not Kraken's words.
  for (const entry of appGuideIndex()) {
    for (const f of entry.fields) if (f.name) for (const w of words(f.text)) plain.add(w);
  }
  for (const s of SYNONYMS) for (const w of words(s.phrase)) plain.add(w);
  vocabulary = { plain, stems: new Set([...plain].map(stem)) };
  return vocabulary;
}

/** A word Kraken itself uses, or one that says nothing about anyone. */
function isAppWord(word: string): boolean {
  const w = word.replace(/'s$/, '');
  const vocab = appVocabulary();
  return (
    STOP.has(w) ||
    GENERIC_UI.has(w) ||
    vocab.plain.has(w) ||
    vocab.stems.has(stem(w)) ||
    /^\d+$/.test(w)
  );
}

/**
 * A capitalized word mid-question that is not a word Kraken itself uses: most
 * likely a person or company ("Where do I see Acme's numbers?"), which makes
 * it a question about Nick's data, not about the app.
 */
function namesSomeone(question: string): boolean {
  const raw = question.trim().split(/\s+/).slice(1);
  const vocab = appVocabulary().plain;
  return raw.some((w) => {
    const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '').replace(/['’]s$/i, '');
    if (!/^[A-Z]/.test(clean)) return false;
    // "Follow-ups" is two words Kraken uses; "Acme" is none.
    return !words(clean).every((part) => vocab.has(part));
  });
}

/** The first word of `list` from `start` that is not "the", "my" and the like. */
function nextWord(list: string[], start: number): string | undefined {
  let i = start;
  while (i < list.length && DETERMINERS.has(list[i]!)) i++;
  return list[i];
}

/**
 * The same check in lowercase, where capitals cannot help: people type "where
 * is my email from bob" or "where is nick's calendly link". A name after
 * "from", "for", "about" and the like, a pronoun there, or a possessive that
 * is not one of Kraken's words, all point at someone's data.
 */
function hasEntityTail(q: string): boolean {
  const list = words(q);
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!;
    if (/'s$/.test(w) && !isAppWord(w)) return true;
    if (!TAIL_PREPS.has(w)) continue;
    const next = nextWord(list, i + 1);
    if (next === undefined) continue;
    if (PRONOUNS.has(next)) return true;
    if (FROM_PEOPLE.has(w) && PEOPLE.has(next)) return true;
    if (!isAppWord(next)) return true;
  }
  // "how do I add jane…": the thing being acted on must be one of Kraken's.
  const verb = HOW_DO_I_VERB.exec(q);
  if (verb) {
    const object = nextWord(words(verb[2] ?? ''), 0);
    if (object !== undefined && !isAppWord(object) && !TAIL_PREPS.has(object)) {
      return !['in', 'on', 'up', 'out', 'off', 'into'].includes(object);
    }
  }
  return false;
}

/**
 * Whether the question asks about Kraken itself (where something is, how a
 * page works) rather than about Nick's mail, deals or meetings. Shape only:
 * the answer is still given only when the search is confident.
 */
export function isAppQuestion(question: string): boolean {
  const q = question.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
  if (!q || q.length > 200) return false;
  if (DATA.some((re) => re.test(q))) return false;
  if (!NAVIGATION.some((re) => re.test(q))) return false;
  if (hasEntityTail(q)) return false;
  return !namesSomeone(question);
}

/**
 * Whether a follow-up leans on the conversation ("where is it?", "how do I
 * send that to them"). In an ongoing thread those belong to the full answer,
 * which reads the history.
 */
export function refersBack(question: string): boolean {
  return /\b(it|that|them|her|him|this|those|these|they|their|his|she|he)\b/.test(
    question.toLowerCase(),
  );
}

/* --------------------------------------------------------------- answer */

export interface AppGuideAnswer {
  /** The message text: the direct answer on the first line, support after. */
  content: string;
  /** The places offered as buttons, best first. */
  matches: AppGuideMatch[];
  /** Only for one confident place: its tour. */
  showMe: boolean;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function locate(match: AppGuideMatch): string {
  if (match.group === 'ask') {
    return match.tabLabel
      ? `${match.tabLabel} is a tab in the Ask Arwin chat, the green button on every page.`
      : "That's me: the Ask Arwin chat, the green button on every page.";
  }
  if (match.tabLabel) return `It's on ${match.pageName}, in the ${match.tabLabel} tab.`;
  return `It's on the ${match.pageName} page, in the menu.`;
}

/** A bare "where is the X" (not "where can I…"): could be a place, or the latest X. */
const BARE_WHERE = /^(where|wheres|where's)\b(?! (can|do|would|should|could) (i|we)\b)/;
const UI_NOUN = /\b(page|tab|setting|settings|button|link|board|card|menu|screen|section)\b/;

/**
 * The instant answer for an app question, or null when the matches are not
 * good enough and the question should go to the full answer as usual. A miss
 * costs a slower answer; a wrong page pointer costs the real one, so this
 * leans hard toward null.
 */
export function answerAppQuestion(question: string): AppGuideAnswer | null {
  if (!isAppQuestion(question)) return null;
  const verdict = judgeMatches(searchAppGuide(question));
  if (verdict.kind === 'none') return null;
  const q = question.trim().toLowerCase().replace(/[’]/g, "'");
  if (verdict.kind === 'confident') {
    const m = verdict.match;
    // "Where are the notes" is about their notes unless it names a page,
    // tab or Help card outright, or says page, tab, link and the like.
    if (BARE_WHERE.test(q) && !m.strong && !UI_NOUN.test(q)) return null;
    return {
      content: [locate(m), sentence(m.why)].join('\n'),
      matches: [m],
      showMe: m.tourHref !== null,
    };
  }
  return {
    content: [
      'That could be one of these places in Kraken.',
      ...verdict.matches.map((m) => `• ${m.title}: ${sentence(m.why)}`),
    ].join('\n'),
    matches: verdict.matches,
    showMe: false,
  };
}

/**
 * The top matches as the bridge routine and the model's tool read them:
 * plain fields, links made absolute with the app's origin when one is given.
 */
export interface AppGuideHint {
  title: string;
  page: string;
  tab: string | null;
  link: string | null;
  tour_link: string | null;
  why: string;
}

export function appGuideHints(
  question: string,
  options: { origin?: string | null; limit?: number; minScore?: number } = {},
): AppGuideHint[] {
  const origin = (options.origin ?? '').replace(/\/+$/, '');
  const minScore = options.minScore ?? MIN_CONFIDENT_SCORE;
  const absolute = (href: string | null) => (href ? `${origin}${href}` : null);
  return searchAppGuide(question, { limit: options.limit ?? 3 })
    .filter((m) => m.score >= minScore)
    .map((m) => ({
      title: m.title,
      page: m.pageName,
      tab: m.tabLabel,
      link: absolute(m.href),
      tour_link: absolute(m.tourHref),
      why: m.why,
    }));
}

/**
 * A match as a citation: the source is Kraken's own Help, `url` opens the
 * page or tab, and `tour_url` (when asked for) starts its guided tour. The
 * Ask chat shows these as buttons rather than source chips.
 */
export function helpCitation(match: AppGuideMatch, options: { tour?: boolean } = {}): Citation {
  return {
    id: `help:${match.id}`,
    kind: 'help',
    ref_id: match.id,
    label: match.title,
    page: null,
    section: 'Kraken Help',
    url: match.href,
    occurred_at: null,
    retrieved_at: null,
    publisher: null,
    excerpt: match.why,
    tour_url: options.tour ? match.tourHref : null,
  };
}

/** The model id an instant app answer is stored with, so it reads apart from model answers. */
export const APP_GUIDE_MODEL = 'kraken-app-guide';

/**
 * Starters for the Ask chat that show it knows its way around Kraken. Each
 * must get an instant answer from the registry (pinned by a test), so a
 * renamed page or tab fails the test rather than leaving a dead suggestion.
 */
export const APP_GUIDE_SUGGESTIONS = [
  'Where are my snoozed tasks?',
  'Where is the job board?',
  'How do I turn on phone alerts?',
] as const;
