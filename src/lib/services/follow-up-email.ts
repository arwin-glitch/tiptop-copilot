import 'server-only';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_USER } from '@/lib/demo/fixtures';
import { demoFollowUpThread } from '@/lib/demo/follow-up-emails-fixtures';
import { gmailFailCode, type GmailReadOptions } from '@/lib/google/gmail-get';
import { readMessageThreadId, readThreadFull } from '@/lib/google/gmail-inbox';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type AppError, type Err, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import {
  readLiveThread,
  THREAD_ID,
  toLiveThread,
  type LiveMessage,
  type LiveThread,
} from './inbox-live';

/**
 * The full email behind a follow-up (Follow-ups and the email session): the
 * newest message of the thread, the one a reply answers, with the messages
 * before it. Read-only, plain text, through the same reader as the Inbox
 * (readThreadFull, then toLiveThread, which flags text aimed at an AI).
 *
 * A person is waiting on it, so it reads through gmail-get's mailbox gate with
 * a short deadline: a rate limit or a Gmail 5xx is tried again for up to 8 s,
 * and the read goes ahead of background reads already queued. It is only
 * asked for after a page has drawn, never while rendering one.
 */

/** One message as the follow-up shows it: the Inbox's message, its text capped. */
export interface FollowUpMessage extends LiveMessage {
  /** The text was cut at MAX_TEXT characters; the rest is in Gmail. */
  truncated: boolean;
}

export interface FollowUpEmail {
  /** The Gmail thread the id led to (a queue item may carry a message id). */
  threadId: string;
  subject: string;
  /** The newest real message, drafts left out: the one a reply answers. */
  focus: FollowUpMessage;
  /** The messages before it, oldest first, at most MAX_EARLIER. */
  earlier: FollowUpMessage[];
  /** Older messages left out of `earlier`; Gmail still has them. */
  earlierHidden: number;
}

/** Characters shown per message. A newsletter can run to megabytes. */
export const MAX_TEXT = 20_000;
/** Earlier messages sent along; a long thread keeps the rest in Gmail. */
export const MAX_EARLIER = 5;
/** As long as the follow-ups list itself is cached. */
const CACHE_MS = 60_000;
/** Threads kept, least recently used dropped first. */
const MAX_CACHED = 30;
const READ_DEADLINE_MS = 8_000;

const NOT_FOUND = 'This email is no longer in Gmail.';
// Statements: the Try again button under them is the action.
const BUSY = 'Gmail is busy right now. Give it a minute.';
const NO_ANSWER = "Gmail didn't answer.";

const cache = processWide('follow-up-email', () => ({
  entries: new Map<string, { at: number; result: Result<FollowUpEmail> }>(),
  inFlight: new Map<string, Promise<Result<FollowUpEmail>>>(),
}));

/** Test hook. */
export function resetFollowUpEmailCache(): void {
  cache.entries.clear();
  cache.inFlight.clear();
}

function capText(m: LiveMessage): FollowUpMessage {
  if (m.text.length <= MAX_TEXT) return { ...m, truncated: false };
  return { ...m, text: m.text.slice(0, MAX_TEXT).trimEnd(), truncated: true };
}

/** The newest message and those before it. Null for a thread with no messages. Pure. */
export function toFollowUpEmail(thread: LiveThread): FollowUpEmail | null {
  const messages = thread.messages.map(capText);
  const focus = messages.at(-1);
  if (!focus) return null;
  const before = messages.slice(0, -1);
  const earlier = before.slice(-MAX_EARLIER);
  return {
    threadId: thread.id,
    subject: thread.subject,
    focus,
    earlier,
    earlierHidden: before.length - earlier.length,
  };
}

/** A failed read in words a person can act on, never Gmail's own. */
function friendly(error: AppError): Err<AppError> {
  if (error.code === 'provider_unauthorized') {
    return err(
      'provider_unauthorized',
      'Gmail needs reconnecting in Settings › Integrations before the email can be shown here.',
    );
  }
  if (error.code === 'not_configured') return { ok: false, error };
  switch (gmailFailCode(error)) {
    case 'rate_limited':
    case 'deadline':
      return err('rate_limited', BUSY, { retryable: true });
    case 'not_found':
      return err('not_found', NOT_FOUND);
    case 'gmail_4xx':
      return err(
        'provider_unavailable',
        'Gmail would not open this email here. Open it in Gmail instead.',
      );
    default:
      return err('provider_unavailable', NO_ANSWER, { retryable: true });
  }
}

const asEmail = (thread: LiveThread): Result<FollowUpEmail> => {
  const email = toFollowUpEmail(thread);
  return email ? ok(email) : err('not_found', NOT_FOUND);
};

async function readFromGmail(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<FollowUpEmail>> {
  // One deadline for every step, from the real clock.
  const opts: GmailReadOptions = {
    retry: { deadline: Date.now() + READ_DEADLINE_MS, front: true },
  };
  let full = await readThreadFull(store, integration, id, opts);
  if (!full.ok && full.error.details?.status === 404) {
    // A queue item may carry a message id: find its thread (read scope).
    const thread = await readMessageThreadId(store, integration, id, opts);
    if (!thread.ok) return friendly(thread.error);
    // The same id again would only 404 again.
    if (thread.value !== id) full = await readThreadFull(store, integration, thread.value, opts);
  }
  if (!full.ok) return friendly(full.error);
  return asEmail(toLiveThread(full.value, new Map(), integration.account_email ?? ''));
}

function remember(key: string, result: Result<FollowUpEmail>, at: number): void {
  cache.entries.delete(key);
  cache.entries.set(key, { at, result });
  while (cache.entries.size > MAX_CACHED) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
}

/**
 * The full email for a follow-up's thread or message id. Cached a minute per
 * mailbox and id (a not-found too; nothing else that failed), and shared
 * between concurrent callers. `fresh` skips the cache but still shares a read
 * already under way. Never throws.
 *
 * Closed until sign-in is limited to TipTop accounts, like Follow-ups itself.
 */
export async function readFollowUpEmail(
  store: DataStore,
  organizationId: string,
  id: string,
  options: {
    now?: number;
    e?: AppEnv;
    fresh?: boolean;
    /** The caller's lookup of the primary integration, when it already has one. */
    integration?: Integration | null;
  } = {},
): Promise<Result<FollowUpEmail>> {
  try {
    if (!THREAD_ID.test(id)) return err('invalid_input', 'Bad id.');
    const e = options.e ?? env();
    const now = options.now ?? Date.now();

    // Before the integration: the demo has a connected row but no mailbox.
    if (e.demoMode) {
      const thread = demoFollowUpThread(id, new Date(now));
      if (thread) return asEmail(toLiveThread(thread, new Map(), DEMO_USER.email));
      const stored = await readLiveThread(store, organizationId, id);
      return stored.ok ? asEmail(stored.value) : err('not_found', NOT_FOUND);
    }
    if (e.authAllowedDomains.length === 0) {
      return err('forbidden', 'This stays closed until sign-in is limited to TipTop accounts.');
    }

    const integration =
      options.integration !== undefined
        ? options.integration
        : await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') {
      return err('not_configured', "Gmail isn't connected, so the email can't be shown here.");
    }

    const key = `${integration.id}:${id.toLowerCase()}`;
    if (!options.fresh) {
      const hit = cache.entries.get(key);
      if (hit && now - hit.at < CACHE_MS) {
        remember(key, hit.result, hit.at);
        return hit.result;
      }
    }
    const pending = cache.inFlight.get(key);
    if (pending) return await pending;

    const run = (async () => {
      try {
        const result = await readFromGmail(store, integration, id);
        if (result.ok) {
          // Under the thread too, so the same thread asked for by its own id is a hit.
          const threadKey = `${integration.id}:${result.value.threadId.toLowerCase()}`;
          if (threadKey !== key) remember(threadKey, result, now);
          remember(key, result, now);
        } else if (result.error.code === 'not_found') {
          remember(key, result, now);
        }
        return result;
      } finally {
        cache.inFlight.delete(key);
      }
    })();
    cache.inFlight.set(key, run);
    return await run;
  } catch {
    // No id and no text: either could say who Nick is writing to.
    log.warn('Reading a follow-up email failed unexpectedly');
    return err('internal', NO_ANSWER, { retryable: true });
  }
}
