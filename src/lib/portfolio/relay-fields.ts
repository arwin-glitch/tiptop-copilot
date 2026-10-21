import { z } from 'zod';

/**
 * The field rules every routine snapshot in #deal-relay is read with (Jobs'
 * `JOBS_V1`, Students' `STUDENTS_V1`): ids, short text, days and run times.
 * Pure and client-safe; the post envelopes and the Slack read are in
 * `src/lib/services/relay-snapshot.ts`.
 */

/** A Gmail thread or message id, hex. Links are rebuilt from it, never taken as given. */
export const GMAIL_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);

/** Required text: trimmed, never blank, at most `max` characters. */
export const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Optional text: blank or missing reads as null, and text past `max` is cut
 * short with an ellipsis. A note a little over the limit must not cost the
 * whole row.
 */
export const optionalText = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (t === '') return null;
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  }, z.string().max(max).nullish());

/** Required text, cut short with an ellipsis past `max` rather than refused. */
export const clippedText = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  }, text(max));

/** A time, as one spelling: parts of one run group by it, however the routine wrote it. */
export const RUN_TIME = z
  .string()
  .datetime()
  .transform((v) => new Date(v).toISOString());

/**
 * A day or a time: "2026-10-01" or an ISO time. A bare day becomes noon UTC,
 * so it shows as that day in any US timezone rather than the evening before.
 */
export const DAY = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: 'Expected a date',
  })
  .transform((v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00.000Z` : new Date(v).toISOString(),
  );

/** A day that may be missing: blank, missing or unreadable reads as null, never a refusal. */
export const optionalDay = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  DAY.nullable().catch(null).default(null),
);

/** The words a routine might write for one value: lowercase, runs of anything else as "_". */
export function enumKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Text as a dedupe key reads it: lowercase, accents and punctuation gone, spaces single. */
export function keyText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * What every snapshot post carries around its items: the run time each part
 * repeats, the part number and count of a list split across posts (Slack
 * caps a message's length), and where the run's scan started.
 */
export const RELAY_ENVELOPE = {
  run_at: RUN_TIME,
  /** Part number of a list split across posts. */
  part: z.number().int().min(1).max(30).optional(),
  /** How many parts the run posted, so a run still posting is never read as whole. */
  parts: z.number().int().min(1).max(30).optional(),
  /** Where this run's scan started: the first run reads further back, later runs since the last. */
  scanned_since: RUN_TIME.nullish(),
  emails_scanned: z.number().int().min(0).max(100_000).nullish(),
};

/** The envelope as the reader sees it. */
export interface RelayEnvelope {
  run_at: string;
  part?: number;
  parts?: number;
  scanned_since?: string | null;
  emails_scanned?: number | null;
}
