import { z } from 'zod';

/**
 * Money and legal tasks: which tasks count, what closes one, and when one is
 * going stale.
 *
 * A task counts when a person marked it, or else when its title or detail
 * matches one of the keyword rules below. The rules are the whole classifier,
 * on purpose: anyone can read why a task is on the Money & legal tab, and the
 * toggle on every task fixes a miss either way.
 *
 * Pure, so the server page, the client rows and the tests share one reading.
 */

export interface MoneyLegalRule {
  key: string;
  /** How the row says why it is here: "Matched wire, invoice". */
  label: string;
  /** Any one matching is a match. Each carries its own flags: SAFE and ACH are case-sensitive. */
  patterns: readonly RegExp[];
}

export const MONEY_LEGAL_RULES: readonly MoneyLegalRule[] = [
  { key: 'wire', label: 'wire', patterns: [/\bwire[sd]?\b/i, /\bwiring\b/i] },
  { key: 'capital_call', label: 'capital call', patterns: [/\bcapital calls?\b/i] },
  { key: 'distribution', label: 'distribution', patterns: [/\bdistributions?\b/i] },
  { key: 'k1', label: 'K-1', patterns: [/\bk-?1s?\b/i] },
  {
    key: 'tax',
    label: 'tax form',
    patterns: [/\btax(?:es)?\b/i, /\bw-?9s?\b/i, /\bw-?8\s?ben(?:-e)?\b/i, /\b1099s?\b/i],
  },
  { key: 'filing', label: 'filing', patterns: [/\bfilings?\b/i, /\bannual reports?\b/i] },
  {
    key: 'signature',
    label: 'signature',
    patterns: [
      /\bsignatures?\b/i,
      /\be-?sign(?:s|ed|ing|ature|atures)?\b/i,
      /\bcountersign(?:s|ed|ing|ature)?\b/i,
    ],
  },
  { key: 'safe', label: 'SAFE', patterns: [/\bSAFEs?\b/, /\bsafe (?:note|agreement)s?\b/i] },
  { key: 'side_letter', label: 'side letter', patterns: [/\bside[- ]letters?\b/i] },
  {
    key: 'subscription_docs',
    label: 'subscription docs',
    patterns: [/\bsub(?:scription)? (?:docs?|documents?|agreements?|booklets?|packets?)\b/i],
  },
  { key: 'spv', label: 'SPV', patterns: [/\bSPVs?\b/i] },
  { key: 'term_sheet', label: 'term sheet', patterns: [/\bterm ?sheets?\b/i] },
  { key: 'invoice', label: 'invoice', patterns: [/\binvoic(?:e|es|ed|ing)\b/i] },
  {
    key: 'payment',
    label: 'payment',
    patterns: [
      /\bpay(?:s|ing|ment|ments|out|outs)?\b/i,
      /\bpaid\b/i,
      /\breimburse(?:s|d|ment|ments)?\b/i,
      /\bfunds received\b/i,
    ],
  },
  {
    key: 'bank',
    label: 'bank',
    patterns: [/\bbank(?:s|ing)?\b/i, /\bACH\b/, /\brouting numbers?\b/i],
  },
  {
    key: 'contract',
    label: 'contract',
    patterns: [
      /\bcontracts?\b/i,
      /\bLPA\b/,
      /\b(?:operating|partnership|purchase|shareholders?|stockholders?|engagement) agreements?\b/i,
    ],
  },
  { key: 'nda', label: 'NDA', patterns: [/\bNDAs?\b/i] },
  {
    key: 'legal',
    label: 'legal',
    patterns: [/\blegal\b/i, /\blawyers?\b/i, /\battorneys?\b/i, /\bnotar(?:y|ize|ized)\b/i],
  },
];

/** The rules a task's title and detail match, in rule order. Empty when none does. */
export function moneyLegalMatches(title: string, detail?: string | null): string[] {
  const text = `${title}\n${detail ?? ''}`;
  return MONEY_LEGAL_RULES.filter((rule) => rule.patterns.some((re) => re.test(text))).map(
    (rule) => rule.label,
  );
}

export interface MoneyLegalState {
  on: boolean;
  /** Who decided: a person's toggle, or the keyword rules. */
  by: 'person' | 'rules';
  /** The rules matched, whoever decided. */
  matched: string[];
}

/** A person's newest toggle wins; with none, the rules decide. */
export function moneyLegalState(
  task: { title: string; detail?: string | null },
  manual: boolean | null | undefined,
): MoneyLegalState {
  const matched = moneyLegalMatches(task.title, task.detail);
  if (typeof manual === 'boolean') return { on: manual, by: 'person', matched };
  return { on: matched.length > 0, by: 'rules', matched };
}

/** Why a task is on the tab, in a few words. Null for a task that is not. */
export function moneyLegalWhy(state: MoneyLegalState): string | null {
  if (!state.on) return null;
  if (state.by === 'person') return 'Marked money & legal';
  return `Matched ${state.matched.join(', ')}`;
}

/* ------------------------------------------------------------------- proof */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTE = z
  .string()
  .trim()
  .max(500, 'Keep the note under 500 characters.')
  .optional()
  .transform((note) => (note ? note : undefined));

/**
 * What closes a money or legal task: a link to the proof (the confirmation
 * email, the signed document, the receipt) or a person on the team saying it
 * is done, each with an optional note. Only web links: a `javascript:` or
 * `data:` URL is refused, since the link is shown back as a link.
 */
export const PROOF_SCHEMA = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('link'),
    url: z
      .string()
      .trim()
      .max(2000, 'That link is too long.')
      .url('That is not a link.')
      .refine((url) => /^https?:\/\//i.test(url), 'Use a web link (https://…).'),
    note: NOTE,
  }),
  z.object({
    kind: z.literal('confirmed'),
    confirmedBy: z.string().regex(UUID_RE, 'Choose who confirmed it.'),
    note: NOTE,
  }),
]);

export type TaskProof = z.infer<typeof PROOF_SCHEMA>;

/**
 * Whether an automatic close states its own proof for a money or legal task:
 * a reason, backed by a sent email that can be opened. A booked meeting
 * proves nothing was paid or signed, and a close with no reason says
 * nothing, so either waits as "needs proof" for a person instead.
 */
export function autoCloseStatesProof(meta: {
  reason?: unknown;
  evidence_type?: unknown;
  evidence_id?: unknown;
}): boolean {
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  return filled(meta.reason) && meta.evidence_type === 'gmail_sent' && filled(meta.evidence_id);
}

/**
 * How long a proof may sit before the completion it explains: the two are
 * written one after the other, so anything older belongs to an earlier close.
 */
export const PROOF_WINDOW_MS = 10 * 60_000;

/** Whether a proof row explains a task's current completion. */
export function proofExplains(proofAt: string, completedAt: string | null): boolean {
  if (!completedAt) return false;
  const proof = Date.parse(proofAt);
  const done = Date.parse(completedAt);
  if (Number.isNaN(proof) || Number.isNaN(done)) return false;
  return proof <= done + 60_000 && done - proof <= PROOF_WINDOW_MS;
}

/* ------------------------------------------------------------------- stale */

/** Days with no activity before an open money or legal task is going stale. */
export const STALE_DAYS = 7;

/**
 * Whole days since `lastActivity` when that is at least STALE_DAYS, else
 * null. An unreadable time is not stale: the marker is a nudge, and a wrong
 * one teaches people to ignore it.
 */
export function staleDays(lastActivity: string | null | undefined, now: Date): number | null {
  const at = lastActivity ? Date.parse(lastActivity) : Number.NaN;
  if (Number.isNaN(at)) return null;
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  return days >= STALE_DAYS ? days : null;
}

/** "Going stale · 9 days quiet". */
export function staleLabel(days: number): string {
  return `Going stale · ${days} days quiet`;
}
