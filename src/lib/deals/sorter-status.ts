import { formatTime, relativeTime } from '@/lib/util/time';

/**
 * What the Deals page says about the deal-sorter, as a pure function of the
 * relay's last pull. One place decides the words, so the status strip and the
 * empty state never disagree, and every state is testable without rendering.
 */

export type SorterState =
  | 'pending'
  | 'not_configured'
  | 'ok'
  | 'bot_not_in_channel'
  | 'missing_scope'
  | 'bad_token'
  | 'rate_limited'
  | 'error';

export interface SorterStatusInput {
  isDemo: boolean;
  state: SorterState;
  missing: readonly string[];
  needed: string | null;
  lastRun: { ts: string; backfillDone: readonly string[]; posted: number } | null;
  /** Live (non-archived) deals on the page. */
  dealCount: number;
  /** Deals the deal-sorter has touched. */
  routineDealCount: number;
  counts: {
    created: number;
    updated: number;
    moved: number;
    skipped_portfolio: number;
    mirrored: number;
  } | null;
  rejected: number;
  now: Date;
  timezone: string;
}

export interface SorterStatusView {
  tone: 'ok' | 'info' | 'warn';
  /** The one-line message. */
  message: string;
  /** A secondary line: the last pull's counts, when there was one. */
  detail: string | null;
  /** Whether the reader should be pointed at the configuration report. */
  configLink: boolean;
}

/** The routine runs at 09:50 and 20:50 UTC. */
export const SORTER_SLOTS_UTC = [
  [9, 50],
  [20, 50],
] as const;

/** A run older than this is stale: two runs a day, so 36 hours means at least two missed. */
export const STALE_AFTER_MS = 36 * 3_600_000;

const BACKFILL_PHASES = ['a1', 'a2', 'a3', 'b1', 'b2', 'c'];
const BACKFILL_STEPS = BACKFILL_PHASES.length;

function slotsInZone(now: Date, timezone: string): string {
  return SORTER_SLOTS_UTC.map(([h, m]) => {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    try {
      return formatTime(at, timezone);
    } catch {
      return formatTime(at, 'UTC');
    }
  }).join(' and ');
}

export function describeDealSorterStatus(input: SorterStatusInput): SorterStatusView {
  const { state, lastRun, now } = input;
  const detail =
    state === 'ok' && input.counts
      ? [
          `${input.counts.created} created`,
          `${input.counts.updated} updated`,
          `${input.counts.moved} moved`,
          `${input.counts.skipped_portfolio} skipped (portfolio)`,
          ...(input.counts.mirrored > 0 ? [`${input.counts.mirrored} added from Portfolio`] : []),
          `${input.rejected} rejected`,
        ].join(' · ')
      : null;

  if (input.isDemo) {
    return {
      tone: 'info',
      message:
        'Demo workspace: sample deals. In a live workspace the deal-sorter routine keeps this list current through the private #deal-relay Slack channel.',
      detail: null,
      configLink: false,
    };
  }

  switch (state) {
    case 'pending':
      return { tone: 'info', message: 'Checking #deal-relay…', detail: null, configLink: false };
    case 'not_configured':
      return {
        tone: 'info',
        message: `Deals arrive automatically from the deal-sorter through the private #deal-relay Slack channel, which isn't connected yet: ${input.missing.join(', ') || 'ASK_RELAY_SLACK_TOKEN'}.`,
        detail: null,
        configLink: true,
      };
    case 'bot_not_in_channel':
      return {
        tone: 'warn',
        message: 'Invite the Copilot Slack app to #deal-relay (/invite) so the app can read it.',
        detail: null,
        configLink: false,
      };
    case 'missing_scope':
      return {
        tone: 'warn',
        message: `The Slack app needs ${input.needed ?? 'groups:history'} to read a private channel. Add it and reinstall the app.`,
        detail: null,
        configLink: true,
      };
    case 'bad_token':
      return {
        tone: 'warn',
        message:
          'Slack refused the app token (ASK_RELAY_SLACK_TOKEN). Replace it in the deployment settings.',
        detail: null,
        configLink: true,
      };
    case 'rate_limited':
      return {
        tone: 'info',
        message: 'Slack is rate-limiting reads of #deal-relay. The next check retries on its own.',
        detail: null,
        configLink: false,
      };
    case 'error':
      return {
        tone: 'warn',
        message:
          "Couldn't read #deal-relay just now, so this is what was stored. It retries in a few seconds.",
        detail: null,
        configLink: false,
      };
    case 'ok':
      break;
  }

  if (!lastRun) {
    if (input.routineDealCount > 0) {
      return {
        tone: 'warn',
        message:
          'No deal-sorter run in the last 30 days. Deals here may be out of date; check the routine.',
        detail,
        configLink: false,
      };
    }
    return {
      tone: 'info',
      message: `Connected. Waiting for the deal-sorter's first run (09:50 and 20:50 UTC, ${slotsInZone(now, input.timezone)} your time).`,
      detail,
      configLink: false,
    };
  }

  const ago = relativeTime(lastRun.ts, now);
  if (now.getTime() - Date.parse(lastRun.ts) > STALE_AFTER_MS) {
    return {
      tone: 'warn',
      message: `The deal-sorter last ran ${ago}, so deals may be out of date. Check the routine.`,
      detail,
      configLink: false,
    };
  }
  if (input.routineDealCount === 0) {
    return {
      tone: 'info',
      message: `The deal-sorter ran ${ago} and has not posted any deals yet.`,
      detail,
      configLink: false,
    };
  }
  const done = BACKFILL_PHASES.filter((p) => lastRun.backfillDone.includes(p)).length;
  if (done < BACKFILL_STEPS) {
    return {
      tone: 'info',
      message: `Importing your pipeline: ${done} of ${BACKFILL_STEPS} steps done · last run ${ago}`,
      detail,
      configLink: false,
    };
  }
  return {
    tone: 'ok',
    message: `Kept current by the deal-sorter · last run ${ago} · ${lastRun.posted} updated`,
    detail,
    configLink: false,
  };
}
