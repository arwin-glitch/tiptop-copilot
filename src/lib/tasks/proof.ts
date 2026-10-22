import { z } from 'zod';
import { softText } from '@/lib/relay/soft-fields';
import { addDaysToKey, formatMonthDay, localClock, wallTimeToUtc } from '@/lib/util/time';
import { isIntroTitle } from './glance';

/**
 * The proof check for tasks a person ticks by hand.
 *
 * Some tasks are only done when something reaches someone: a reply, a send,
 * feedback handed back, an intro, a signature, a payment. When a person ticks
 * one of those, the app keeps a note of what should have gone out and to whom,
 * looks for it, and after a grace window of two business days says so if it
 * never saw it. It never reopens anything: the person decides.
 *
 * This file is the pure part: which titles are deliverables (plain rules,
 * conservative on purpose, so a to-do like "Prepare LPAC agenda" is never
 * one), the business-day window, and the labels. Pure, so the server, the
 * rows and the tests share one reading.
 */

export const DELIVERABLE_KINDS = ['reply', 'send', 'review', 'intro', 'sign', 'payment'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/**
 * What can show a deliverable went out. The app itself reads only the first
 * (the synced mailbox); the rest come from the task-closer's `TASK_PROOF_V1`
 * posts, since the app cannot read Slack DMs or judge a payment receipt.
 */
export const PROOF_EVIDENCE_TYPES = [
  'gmail_sent',
  'slack_message',
  'payment_confirmation',
  'signature_confirmation',
  'calendar_event',
] as const;
export type ProofEvidenceType = (typeof PROOF_EVIDENCE_TYPES)[number];

const PROOF_BY_KIND: Record<DeliverableKind, readonly ProofEvidenceType[]> = {
  reply: ['gmail_sent', 'slack_message'],
  send: ['gmail_sent', 'slack_message'],
  review: ['gmail_sent', 'slack_message'],
  intro: ['gmail_sent'],
  sign: ['gmail_sent', 'signature_confirmation'],
  payment: ['gmail_sent', 'payment_confirmation'],
};

export interface Deliverable {
  kind: DeliverableKind;
  /**
   * Who should receive it, as the task names them: "Dana", "Dana Ortiz",
   * "LoomStack", "dana@example.com". An intro names both parties when it can.
   */
  recipients: string[];
  /** What counts as proof, in order of preference. */
  proof: ProofEvidenceType[];
}

/* ------------------------------------------------------------------- names */

/**
 * Capitalised words that are never a recipient: pronouns, groups, the
 * calendar and the acronyms task titles are full of.
 */
const NOT_A_NAME = new Set(
  [
    'i',
    'me',
    'my',
    'myself',
    'nick',
    'us',
    'we',
    'you',
    'them',
    'him',
    'her',
    'it',
    'the',
    'a',
    'an',
    'team',
    'everyone',
    'everybody',
    'all',
    'lp',
    'lps',
    'gp',
    'gps',
    'lpac',
    'board',
    'investors',
    'founders',
    'partners',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'today',
    'tomorrow',
    'tonight',
    'eod',
    'eow',
    'asap',
    'tbd',
    'fyi',
    'ai',
    'nda',
    'ndas',
    'safe',
    'safes',
    'spv',
    'pdf',
    'ceo',
    'cfo',
    'cto',
    'coo',
    'dd',
    'kpi',
    'kpis',
    'arr',
    'mrr',
    'ic',
    'vc',
    'vcs',
    'us',
    'usa',
    'uk',
    'eu',
    'series',
    'fund',
    'q',
    'docs',
    'deck',
    // Nouns a Title Case task puts where a name would go: "Send Monthly
    // Update", "Send Invoice", "Answer Questionnaire" name no one.
    'folks',
    'people',
    'mom',
    'dad',
    'update',
    'updates',
    'invoice',
    'invoices',
    'reminder',
    'reminders',
    'thank',
    'thanks',
    'calendar',
    'invite',
    'invites',
    'invitation',
    'daily',
    'weekly',
    'monthly',
    'quarterly',
    'annual',
    'investor',
    'newsletter',
    'report',
    'reports',
    'equipment',
    'sequence',
    'final',
    'signed',
    'new',
    'next',
    'draft',
    'revised',
    'updated',
    'memo',
    'notes',
    'summary',
    'recap',
    'agenda',
    'materials',
    'proposal',
    'contract',
    'agreement',
    'questionnaire',
    'survey',
    'rfp',
    'form',
    'link',
    'details',
    'info',
    'feedback',
    'email',
    'message',
    'letter',
    'slides',
    'data',
    'access',
    'budget',
    'bank',
    'amex',
    'crm',
    'google',
    'slack',
    'linkedin',
    'zoom',
  ].map((w) => w.toLowerCase()),
);

/** One capitalised word: "Dana", "O'Neil", "LoomStack", "QRX". */
const CAP = String.raw`[A-Z][A-Za-z]*(?:['’\-][A-Za-z]+)*`;
/** A first name and, optionally, a second capitalised word. */
const NAME = String.raw`${CAP}(?:\s+${CAP})?`;
const EMAIL = String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`;
const WHO = `(?:${EMAIL}|${NAME})`;
/** Case matters for names, so these are matched case-sensitively; the verbs are not. */
const LEADING_WHO = new RegExp(`^(${WHO})(?![\\w@])`);

const POSSESSIVE = /['’]s?$/;

/** A matched name cleaned up, or null when it is not a recipient. */
function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.includes('@')) return text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || NOT_A_NAME.has(words[0]!.toLowerCase())) return null;
  // "Maya Monday", "Dana EOD": a second word that is not a name is dropped.
  if (words[1] && NOT_A_NAME.has(words[1].replace(POSSESSIVE, '').toLowerCase())) {
    words.length = 1;
  }
  const last = words.length - 1;
  words[last] = words[last]!.replace(POSSESSIVE, '');
  const name = words.join(' ');
  return name.length >= 2 ? name : null;
}

function isPossessive(raw: string): boolean {
  return /['’]s$/.test(raw.trim());
}

/** The name `text` starts with, as written, before cleaning. */
function leadingRaw(text: string): string | null {
  return LEADING_WHO.exec(text)?.[1] ?? null;
}

/** The first `<connector> <name>` in `text` that is a name; connectors are lowercase words. */
function nameAfter(text: string, connectors: string): string | null {
  const re = new RegExp(`(?:^|\\s)(?:${connectors})\\s+(?:the\\s+)?(${WHO})(?![\\w@])`, 'g');
  for (const match of text.matchAll(re)) {
    const name = cleanName(match[1]);
    if (name) return name;
  }
  return null;
}

const EMAIL_RE = new RegExp(EMAIL, 'g');

/** Every address written out in `text`, lowercased. */
export function emailsIn(text: string | null | undefined): string[] {
  return [...new Set((text ?? '').match(EMAIL_RE)?.map((e) => e.toLowerCase()) ?? [])];
}

/* ------------------------------------------------------------------- rules */

/** A tag or "Re:" in front of the verb: "[Urgent] Reply to Dana". */
const LEAD_RE = /^(?:\[[^\]]{1,30}\]\s*)?(?:re:\s*)?/i;

const REPLY_VERB = /^(?:reply|respond|write back|get back|answer|revert)\b\s*(?:to\s+)?/i;
const SEND_VERB = /^(?:send|email|e-mail|forward|give|pass|share|return|hand)\s+/i;
const TELL_VERB = /^(?:tell|notify|update)\s+/i;
/** "Let Riley know": the name keeps its capital, so "let folks know" names no one. */
const LET_KNOW_RE = new RegExp(`^[Ll]et\\s+(${NAME})\\s+know\\b`);
const REVIEW_VERB =
  /^(?:review|proofread|mark up|markup|edit|comment on|look over|go through|read through|redline)\s+/i;
/** "Sign up for", "sign in to", "sign off on": not a signature anyone receives. */
const SIGN_VERB =
  /^(?:sign|countersign|e-?sign|docusign|execute)\s+(?!(?:up|in|into|out|on|off)\b)/i;
/** "Pay attention to", "pay a visit", "wire instructions": not a payment. */
const PAY_VERB =
  /^(?:pay(?!\s+(?:attention|a visit|visits?|respects?|homage|tribute|off|down|up)\b)|reimburse|wire(?!\s+(?:instructions|details|info)\b)|send (?:the )?(?:wire|payment|funds)|confirm (?:the )?(?:payment|wire|transfer))\b\s*/i;
const INTRO_VERB =
  /^(?:make\s+|send\s+)?(?:an\s+|the\s+)?(?:intro(?:duction)?|introduce|connect)\b[\s:–—-]*/i;
/** "Intro coffee with Dana" is a meeting, like an "intro call". */
const INTRO_MEETING =
  /^(?:coffee|call|meeting|chat|lunch|dinner|drinks|zoom|session|catch[- ]?up|sync)\b/i;
/** "Introduce myself to Dana" is a note to Dana, not an intro between two people. */
const INTRO_SELF = /^(?:myself|ourselves|me|us)\b/i;
/**
 * A call, a calendar invite or a meeting goes out by phone or calendar, where
 * the app cannot look: "Give Dana a call", "Send Maya an invite". Notes from
 * one are still a send ("Send Dana the call notes").
 */
const CALL_OR_INVITE =
  /\b(?:call|ring|buzz|invite|invitation|screen)\b(?!\s+(?:notes?|recap|summary|transcript|recording|agenda|deck|memo|slides|minutes|list))/i;
/** Said to go by Slack, phone, text or in person: the app looks only at email. */
const ELSEWHERE =
  /\b(?:in|on|via|over|by)\s+(?:slack|whatsapp|signal|text|sms|imessage|the phone|phone|a call|zoom|person)\b/i;
const ARROW = /\s*(?:→|->|=>|<>|↔)\s*/;
/** Words that make a send a review: the thing handed back is someone's work, marked up. */
const FEEDBACK_RE = /\b(?:feedback|comments|notes on|edits|thoughts|markup|redlines?)\b/i;
/** What follows a ditransitive recipient: "Send Maya the shortlist". */
const OBJECT_START =
  /^\s+(?:the|a|an|our|my|this|that|these|those|some|his|her|their|feedback|notes|comments|edits|thoughts|an?\s)\b/;

/** The parties of an intro, from its title. */
function introParties(title: string): string[] {
  const text = title.replace(INTRO_VERB, '');
  const sides = text.split(ARROW);
  const names: string[] = [];
  const add = (raw: string | null) => {
    const name = cleanName(raw ?? undefined);
    if (name && !names.includes(name)) names.push(name);
  };
  if (sides.length >= 2) {
    for (const side of sides.slice(0, 2)) {
      for (const part of side.split(/\s*(?:&|,|\band\b|\+)\s*/)) add(leadingRaw(part.trim()));
    }
    return names;
  }
  if (text === title) return names; // "Send … intros": no verb to read parties after.
  const between = /^between\s+/.exec(text);
  const rest = between ? text.slice(between[0].length) : text;
  add(leadingRaw(rest));
  add(nameAfter(rest, 'to|with|and'));
  return names;
}

/**
 * Whether a task is a deliverable, and if so what kind, who should receive it
 * and what counts as proof. The title decides; the detail only adds an email
 * address written out in it. A deliverable needs a named recipient, except a
 * reply, whose recipient can come from the email the task was made from (the
 * caller adds that). Null for everything else.
 */
export function classifyDeliverable(title: string, detail?: string | null): Deliverable | null {
  const text = title.replace(/\s+/g, ' ').trim().replace(LEAD_RE, '');
  const detailEmails = emailsIn(detail);
  const make = (kind: DeliverableKind, recipients: (string | null)[]): Deliverable | null => {
    const named = [...new Set(recipients.filter((r): r is string => !!r))];
    const all = named.length > 0 ? named : detailEmails;
    if (all.length === 0 && kind !== 'reply') return null;
    return { kind, recipients: all, proof: [...PROOF_BY_KIND[kind]] };
  };

  if (ELSEWHERE.test(text)) return null;

  if (isIntroTitle(text)) {
    const rest = text.replace(INTRO_VERB, '');
    if (rest !== text && !ARROW.test(text)) {
      if (INTRO_MEETING.test(rest)) return null;
      if (INTRO_SELF.test(rest)) return make('send', [nameAfter(rest, 'to')]);
    }
    const parties = introParties(text);
    // "Connect with Dana", "Connect on LinkedIn with Dana": a connect names both sides or is no intro.
    if (/^connect\b/i.test(text) && parties.length < 2) return null;
    return parties.length > 0 ? make('intro', parties) : null;
  }

  const reply = REPLY_VERB.exec(text);
  if (reply) {
    const rest = text.slice(reply[0].length);
    // "Answer Dana's question" is to Dana too.
    return make('reply', [cleanName(leadingRaw(rest) ?? undefined)]);
  }

  const letKnow = LET_KNOW_RE.exec(text);
  if (letKnow) return make('send', [cleanName(letKnow[1])]);

  const tell = TELL_VERB.exec(text);
  if (tell) {
    const rest = text.slice(tell[0].length);
    const raw = leadingRaw(rest);
    // "Update the deck" is not a send; "Update Maya on the round" is.
    const followed = raw ? rest.slice(raw.length) : '';
    // "Update Pipewise with the notes" fills in a tool, and "Update Ledgerbook on Friday" says when.
    if (
      raw &&
      !isPossessive(raw) &&
      /^\s+(?:on|about|that|re|we)\b/.test(followed) &&
      !/^\s+on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i.test(
        followed,
      )
    ) {
      return make('send', [cleanName(raw)]);
    }
    if (raw && /^tell\s/i.test(text) && !isPossessive(raw)) return make('send', [cleanName(raw)]);
    return null;
  }

  const pay = PAY_VERB.exec(text);
  if (pay) {
    const rest = text.slice(pay[0].length).replace(/^the\s+/, '');
    const raw = leadingRaw(rest);
    return make('payment', [
      raw && !/^(?:invoice|bill)\b/i.test(raw) ? cleanName(raw) : null,
      nameAfter(rest, 'to|for'),
    ]);
  }

  const sign = SIGN_VERB.exec(text);
  if (sign) {
    const rest = text.slice(sign[0].length);
    const company = /^the\s+/.test(rest) ? leadingRaw(rest.replace(/^the\s+/, '')) : null;
    const companyFollowed = company
      ? /^\s+[a-z]/.test(rest.replace(/^the\s+/, '').slice(company.length))
      : false;
    return make('sign', [
      nameAfter(rest, 'for|to|back to|from|with'),
      companyFollowed ? cleanName(company!) : null,
    ]);
  }

  const review = REVIEW_VERB.exec(text);
  if (review) {
    const rest = text.slice(review[0].length);
    // Reviewing alone is not a deliverable; handing it back to someone is.
    const so = new RegExp(`(?:^|\\s)so\\s+(?:that\\s+)?(${NAME})\\s+can\\b`).exec(rest);
    const forTo = new RegExp(`(?:^|\\s)for\\s+(${NAME})\\s+to\\b`).exec(rest);
    return make('review', [
      cleanName(so?.[1]),
      nameAfter(rest, 'back to|over to'),
      nameAfter(rest, String.raw`and (?:send|return|get|pass|hand)(?: it| them)?(?: back)? to`),
      nameAfter(rest, String.raw`(?:feedback|comments|notes|edits|thoughts) (?:to|for)`),
      cleanName(forTo?.[1]),
    ]);
  }

  const send = SEND_VERB.exec(text);
  if (send) {
    const verb = send[0].trim().toLowerCase();
    const rest = text.slice(send[0].length);
    // A call or an invite is not an email, unless the verb is one; "Return to Lisbon" is a trip.
    if (!/^(?:email|e-mail|forward)$/.test(verb) && CALL_OR_INVITE.test(rest)) return null;
    if (verb === 'return' && /^to\b/i.test(rest)) return null;
    const kind: DeliverableKind = FEEDBACK_RE.test(rest) ? 'review' : 'send';
    const raw = leadingRaw(rest);
    const lead = raw && !isPossessive(raw) ? cleanName(raw) : null;
    const after = raw ? rest.slice(raw.length) : '';
    // "Send Maya the shortlist", "Email Dana": the name right after the verb receives it.
    if (lead && (OBJECT_START.test(after) || /^\s*(?:$|[-–—:(,.])/.test(after))) {
      return make(kind, [lead]);
    }
    const to = nameAfter(rest, verb === 'share' ? 'with|to' : 'to|back to');
    if (to) return make(kind, [to]);
    // "Send LoomStack pass note": a name, then the thing.
    if (lead && /^\s+[a-z]/.test(after)) return make(kind, [lead]);
    return make(kind, []);
  }

  return null;
}

/* ------------------------------------------------------------ the window */

/** Business days a deliverable has to show up before the app says it did not. */
export const PROOF_GRACE_BUSINESS_DAYS = 2;

function weekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

const isWeekend = (dateKey: string) => {
  const day = weekday(dateKey);
  return day === 0 || day === 6;
};

/**
 * `at` plus `days` business days in `timeZone`, at the same wall time:
 * Friday 4pm plus two is Tuesday 4pm. Time on a weekend does not count, so a
 * tick on Saturday counts from Monday morning.
 */
export function addBusinessDays(at: Date, days: number, timeZone: string): Date {
  const clock = localClock(at, timeZone);
  let key = clock.dateKey;
  let hour = clock.hour;
  let minute = clock.minute;
  if (isWeekend(key)) {
    while (isWeekend(key)) key = addDaysToKey(key, 1);
    hour = 0;
    minute = 0;
  }
  for (let left = days; left > 0;) {
    key = addDaysToKey(key, 1);
    if (!isWeekend(key)) left--;
  }
  return wallTimeToUtc(key, hour, minute, timeZone) ?? new Date(at.getTime() + days * 86_400_000);
}

/** When the app may judge a deliverable ticked at `completedAt`. */
export function proofJudgeAfter(completedAt: Date, timeZone: string): Date {
  return addBusinessDays(completedAt, PROOF_GRACE_BUSINESS_DAYS, timeZone);
}

/* ------------------------------------------------------------ the labels */

/** What a Completed row or Today's card shows for a ticked deliverable. */
export type ProofCheckView =
  | { state: 'seen'; label: string; href: string | null }
  | { state: 'flagged'; label: string; detail: string };

/** "Riley", "Maya and Dana", "Maya, Dana and Sam". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The quiet note on a Completed row whose deliverable was seen. */
export function seenSentLabel(
  evidenceType: string | null,
  evidenceAt: string | null,
  recipients: readonly string[],
  timeZone: string,
): string {
  const to = recipients.length > 0 ? ` to ${joinNames(recipients.slice(0, 2))}` : '';
  const what =
    evidenceType === 'slack_message'
      ? `Slack message${to}`
      : evidenceType === 'payment_confirmation'
        ? 'payment confirmation'
        : evidenceType === 'signature_confirmation'
          ? 'signed copy'
          : evidenceType === 'calendar_event'
            ? 'meeting'
            : `email${to}`;
  const date =
    evidenceAt && !Number.isNaN(Date.parse(evidenceAt)) ? formatMonthDay(evidenceAt, timeZone) : '';
  return `Seen sent · ${what}${date ? `, ${date}` : ''}`;
}

/** What a flagged row says under its chip. */
export function notSeenLabel(
  completedAt: string | null,
  recipients: readonly string[],
  addressed: boolean,
  timeZone: string,
): string {
  const ticked =
    completedAt && !Number.isNaN(Date.parse(completedAt))
      ? `Ticked ${formatMonthDay(completedAt, timeZone)}`
      : 'Ticked';
  const who = joinNames(recipients.slice(0, 2));
  if (!who) return `${ticked} · no sent email found since`;
  if (!addressed) return `${ticked} · no address found for ${who}, so no email could be matched`;
  return `${ticked} · no email to ${who} seen since`;
}

/* ------------------------------------------------------------ the relay */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the task-closer calls the deliverable, as its own close kinds do, plus the ones a hand tick adds. */
export const PROOF_RELAY_KINDS = [
  'reply',
  'intro',
  'send_doc',
  'review',
  'decision',
  'payment',
  'sign',
  'followup',
] as const;

/**
 * One proof in a `TASK_PROOF_V1` post: like a `TASK_CLOSE_V1` close, with the
 * extra evidence types a hand tick can be proved by. It never closes,
 * reopens or changes a task; it only marks a ticked task "Seen sent".
 */
export const TASK_PROOF_SCHEMA = z.object({
  task_id: z.string().trim().regex(UUID_RE, 'must be a task id').optional(),
  // Strict: a proof is matched to its ticked task by this title.
  title: z.string().trim().min(1).max(300),
  kind: z.enum(PROOF_RELAY_KINDS),
  evidence_at: z.string().datetime({ offset: true }),
  evidence: z.object({
    type: z.enum(PROOF_EVIDENCE_TYPES),
    id: z.string().trim().min(1).max(200),
    thread_id: z.string().trim().min(1).max(200).optional(),
    channel: z
      .string()
      .trim()
      .regex(/^[CDG][A-Z0-9]{6,20}$/, 'must be a Slack channel id')
      .optional(),
    to: z.array(z.string().trim().max(320)).max(20).optional(),
  }),
  /** Display only: a long one is cut at a word, never a reason to drop the proof (D-073). */
  reason: softText(300),
});

export type TaskProofRelay = z.infer<typeof TASK_PROOF_SCHEMA>;
