/**
 * How fast and how much a campaign sends. Pure, so the composer can say how
 * long a send will take and the server can enforce the same numbers.
 *
 * Gmail lets a Workspace mailbox send far more than this, but it watches for
 * bursts, and an LP update that trips a sending block takes Nick's mailbox
 * down with it. So: about one email every two seconds, in short batches a
 * request can finish well inside the host's limits, and at most 400 a day.
 */

/** Pause between two emails, per organization. */
export const SEND_INTERVAL_MS = 2_000;

/** Emails one batch request sends at most. */
export const BATCH_MAX = 10;

/** A batch stops starting new sends after this long, so a request never runs long. */
export const BATCH_BUDGET_MS = 25_000;

/** Emails the organization's campaigns send in any 24 hours. */
export const DAILY_CAP = 400;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Recipients one campaign can hold. */
export const MAX_RECIPIENTS = 2_000;

/** Attachments on one campaign, together. The inbox composer's limit too. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const MAX_ATTACHMENTS = 10;

/**
 * Bytes per upload request. The proxy buffers request bodies up to 10MB and
 * silently cuts the rest, so a file is sent in pieces well under that.
 */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** A send attempt older than this that never finished was interrupted. */
export const INTERRUPTED_AFTER_MS = 2 * 60 * 1000;

/**
 * How long a batch's send lease lasts without renewal. It is renewed before
 * every email, so only a crashed or stuck batch lets it lapse; it is shorter
 * than INTERRUPTED_AFTER_MS, so a batch that takes over from a stuck one still
 * sees the stuck attempt as in flight and waits rather than reporting it.
 */
export const SEND_LEASE_MS = 90_000;

/**
 * A "sending" campaign that has done nothing for this long has no page
 * driving it: it is shown as stopped rather than sending.
 */
export const STALLED_AFTER_MS = 2 * 60 * 1000;

/** Failures in a row that pause a campaign rather than burn through the list. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface DailyCapState {
  /** Sent in the last 24 hours. */
  used: number;
  remaining: number;
  /** When the next email may go, once the cap is reached; null while under it. */
  resetsAt: string | null;
}

/**
 * The rolling 24-hour cap from the send times in that window. Once full, the
 * next slot opens when the oldest send in the window turns a day old.
 */
export function dailyCapState(
  sentAt: readonly string[],
  now: Date,
  cap: number = DAILY_CAP,
): DailyCapState {
  const since = now.getTime() - DAY_MS;
  const times = sentAt
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t) && t > since)
    .sort((a, b) => a - b);
  const used = times.length;
  const remaining = Math.max(0, cap - used);
  if (remaining > 0) return { used, remaining, resetsAt: null };
  // The slot that frees first is the (used - cap + 1)th oldest.
  const freeing = times[used - cap] ?? times[0] ?? now.getTime();
  return { used, remaining, resetsAt: new Date(freeing + DAY_MS).toISOString() };
}

/** How long until the next email may go, given the last one. */
export function waitBeforeNext(
  lastSentAt: string | null | undefined,
  now: number,
  intervalMs: number = SEND_INTERVAL_MS,
): number {
  if (!lastSentAt) return 0;
  const last = Date.parse(lastSentAt);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, Math.min(intervalMs, last + intervalMs - now));
}

/** Roughly how long sending to `count` people takes at the paced rate, in minutes (at least 1). */
export function estimatedMinutes(count: number, intervalMs: number = SEND_INTERVAL_MS): number {
  return Math.max(1, Math.ceil((count * intervalMs) / 60_000));
}

/** "a minute", "about 4 minutes". */
export function describeMinutes(minutes: number): string {
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
