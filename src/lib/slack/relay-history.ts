/**
 * Reading a window of a relay channel's history, shared by the deal pull and
 * the task-closer pull (both read #deal-relay).
 *
 * Slack returns pages newest first; this collects up to `maxPages` of them
 * within `windowDays`, and maps a refusal to a state a page can name rather
 * than throwing. A network fault or a 5xx comes back as `error` with the
 * thrown value in `fault`, for the caller to log in its own words.
 */

export interface SlackMessage {
  text?: unknown;
  ts?: unknown;
  user?: unknown;
  subtype?: unknown;
}

interface SlackHistoryBody {
  ok?: boolean;
  error?: string;
  needed?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export type RelayReadState =
  'ok' | 'bot_not_in_channel' | 'missing_scope' | 'bad_token' | 'rate_limited' | 'error';

export const SLACK_ERROR_STATES: Record<string, RelayReadState> = {
  not_in_channel: 'bot_not_in_channel',
  channel_not_found: 'bot_not_in_channel',
  missing_scope: 'missing_scope',
  invalid_auth: 'bad_token',
  not_authed: 'bad_token',
  token_revoked: 'bad_token',
  account_inactive: 'bad_token',
  ratelimited: 'rate_limited',
};

export interface RelayWindowOptions {
  token: string;
  channelId: string;
  windowDays: number;
  maxPages: number;
  pageSize: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Per call. */
  timeoutMs?: number;
  /** How long to wait after a refusal; a rate limit waits at least this. */
  refusalRetryMs?: number;
  /** How long to wait after a network fault or a 5xx. */
  faultRetryMs?: number;
}

export interface RelayWindow {
  state: RelayReadState;
  /** The scope Slack says is missing, for `missing_scope`. */
  needed: string | null;
  /** Newest first, as Slack returns them. */
  messages: SlackMessage[];
  /** When the caller should next try. */
  retryIn: number;
  fault?: unknown;
}

export async function readRelayWindow(options: RelayWindowOptions): Promise<RelayWindow> {
  const {
    token,
    channelId,
    windowDays,
    maxPages,
    pageSize,
    now = new Date(),
    fetchImpl = fetch,
    timeoutMs = 8_000,
    refusalRetryMs = 60_000,
    faultRetryMs = 10_000,
  } = options;
  const oldest = Math.floor((now.getTime() - windowDays * 86_400_000) / 1000);
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url =
        `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
          channelId,
        )}&limit=${pageSize}&oldest=${oldest}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        return {
          state: 'rate_limited',
          needed: null,
          messages: [],
          retryIn: Math.max(refusalRetryMs, seconds > 0 ? seconds * 1000 : 0),
        };
      }
      if (response.status >= 500) throw new Error(`Slack answered ${response.status}`);
      const body = (await response.json()) as SlackHistoryBody;
      if (!body.ok) {
        const state = SLACK_ERROR_STATES[body.error ?? ''] ?? 'error';
        const seconds = Number(response.headers.get('retry-after'));
        return {
          state,
          needed: state === 'missing_scope' ? (body.needed ?? 'groups:history') : null,
          messages: [],
          // A refusal will not clear in ten seconds; a rate limit says when.
          retryIn: Math.max(refusalRetryMs, seconds > 0 ? seconds * 1000 : 0),
        };
      }
      messages.push(...(body.messages ?? []));
      cursor = body.response_metadata?.next_cursor || undefined;
      if (!cursor || body.has_more === false) break;
    }
    return { state: 'ok', needed: null, messages, retryIn: refusalRetryMs };
  } catch (error) {
    return { state: 'error', needed: null, messages: [], retryIn: faultRetryMs, fault: error };
  }
}

/** A Slack `ts` ("1790000100.000100") as an ISO time, or null. */
export function slackTsToIso(ts: unknown): string | null {
  if (typeof ts !== 'string' || !/^\d+(\.\d+)?$/.test(ts)) return null;
  return new Date(Number(ts) * 1000).toISOString();
}
