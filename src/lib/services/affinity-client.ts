import 'server-only';
import { log } from '@/lib/security/redact';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The HTTP side of the daily Affinity sync: authenticated GETs against
 * Affinity's public API with rate-limit handling.
 *
 * The API key travels only in the Authorization header of a request to
 * api.affinity.co. It is never logged, never part of an error, and a URL from
 * a response (`pagination.nextUrl`) is followed only if it is on that host —
 * a response cannot send the key anywhere else.
 *
 * Errors carry a status code and a fixed message, never a response body: a
 * body is the customer's data, and errors end up in logs and in the public
 * GitHub Actions log of the daily job.
 *
 * Affinity allows 900 requests a minute per user and answers 429 past that
 * (or past a monthly or concurrency cap). A 429 or a 5xx is retried after
 * `Retry-After`, else `X-Ratelimit-Limit-User-Reset`, else an exponential
 * backoff — unless waiting would run past the caller's deadline, in which
 * case the call gives up as `rate_limited` and the sync resumes from the same
 * page on its next call.
 */

export const AFFINITY_API_ORIGIN = 'https://api.affinity.co';

/**
 * Pinned, so a change of the app's default version in Affinity's settings
 * cannot change the shapes the sync reads.
 */
export const AFFINITY_API_VERSION = '2024-01-01';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

export type AffinityQuery = Record<string, string | number | readonly string[] | null | undefined>;

/** A v2 API URL with query parameters; arrays repeat the parameter, as Affinity expects. */
export function affinityUrl(path: string, query: AffinityQuery = {}): string {
  const url = new URL(path, AFFINITY_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export interface AffinityHttpOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Epoch ms past which the client stops waiting out rate limits and gives up the call. */
  deadline?: number;
  /** Retries of one request after a 429, a 5xx or a network failure. */
  maxRetries?: number;
}

export interface AffinityHttp {
  /** GET a path (`/v2/lists`) or a `pagination.nextUrl` from an earlier response. */
  get<T>(pathOrUrl: string, query?: AffinityQuery): Promise<Result<T>>;
  /** Requests sent so far, retries included. */
  readonly requests: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long a 429 asks to wait, from `Retry-After` (seconds or a date) or the user reset header. */
export function affinityRetryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = Number(headers.get('x-ratelimit-limit-user-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.ceil(reset * 1000);
  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** The request target, or null when it is not an Affinity API URL. */
function target(pathOrUrl: string, query?: AffinityQuery): string | null {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    if (!pathOrUrl.startsWith(`${AFFINITY_API_ORIGIN}/`)) return null;
    return query && Object.keys(query).length ? null : pathOrUrl;
  }
  return pathOrUrl.startsWith('/v1/') || pathOrUrl.startsWith('/v2/')
    ? affinityUrl(pathOrUrl, query)
    : null;
}

/** The path of a request, for logs: never the query (cursors, filters) and never the key. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

export function createAffinityHttp(options: AffinityHttpOptions): AffinityHttp {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? 5;
  const authorization = `Bearer ${options.apiKey}`;
  let requests = 0;

  const canWait = (ms: number) => options.deadline === undefined || now() + ms < options.deadline;

  async function get<T>(pathOrUrl: string, query?: AffinityQuery): Promise<Result<T>> {
    const url = target(pathOrUrl, query);
    if (!url) {
      log.warn('Affinity sync refused a request outside the Affinity API', {
        path: pathOf(pathOrUrl),
      });
      return err('invalid_input', 'The Affinity sync only calls api.affinity.co.');
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        requests++;
        response = await send(url, {
          method: 'GET',
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            'X-Affinity-Api-Version': AFFINITY_API_VERSION,
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        const wait = backoffMs(attempt);
        if (attempt < maxRetries && canWait(wait)) {
          await sleep(wait);
          continue;
        }
        log.warn('Affinity could not be reached', { path: pathOf(url) });
        return err('provider_unavailable', 'Affinity could not be reached.', { retryable: true });
      }

      if (response.status === 429 || response.status >= 500) {
        // Drain the body so the connection can be reused; its content is not read.
        await response.body?.cancel().catch(() => {});
        const asked =
          response.status === 429 ? affinityRetryAfterMs(response.headers, now()) : null;
        const wait = Math.min(Math.max(asked ?? backoffMs(attempt), 250), MAX_WAIT_MS);
        if (attempt < maxRetries && canWait(wait)) {
          await sleep(wait);
          continue;
        }
        log.warn('Affinity request gave up', { path: pathOf(url), status: response.status });
        return response.status === 429
          ? err(
              'rate_limited',
              'Affinity is limiting requests just now; the sync picks up where it stopped.',
              { retryable: true },
            )
          : err('provider_unavailable', `Affinity answered ${response.status}.`, {
              retryable: true,
            });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) {
          return err(
            'provider_unauthorized',
            'Affinity refused the API key. Check AFFINITY_API_KEY on Render, or generate a new key in Affinity.',
          );
        }
        // The key is fine but may not read this (a list made private since).
        if (response.status === 403) {
          return err('forbidden', 'The Affinity key may not read this.');
        }
        if (response.status === 404) return err('not_found', 'Affinity has no such item.');
        log.warn('Affinity request failed', { path: pathOf(url), status: response.status });
        return err('provider_unavailable', `Affinity answered ${response.status}.`);
      }

      try {
        return ok((await response.json()) as T);
      } catch {
        return err('provider_unavailable', 'Affinity sent a response that could not be read.', {
          retryable: true,
        });
      }
    }
  }

  return {
    get,
    get requests() {
      return requests;
    },
  };
}
