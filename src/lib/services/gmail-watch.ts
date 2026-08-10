import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { GmailProvider } from '@/lib/email/gmail';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Keeping the Gmail push registration alive.
 *
 * `users.watch` lapses after seven days — Google's limit, not a setting — so a
 * registration made once and forgotten stops delivering silently, and a mailbox
 * that has stopped notifying is indistinguishable from a quiet one. Renewal
 * therefore has to be somebody's job, and the daily run is the natural owner:
 * it already visits every organization, and running it early enough leaves days
 * of margin before a lapse.
 *
 * Registering is also idempotent and cheap, so the same call handles the first
 * registration. There is no separate "enable push" step to forget.
 */

/** Renew when the registration has less than this left. */
const RENEW_WITHIN_MS = 48 * 60 * 60 * 1000;

export interface WatchOutcome {
  /** 'registered' | 'renewed' | 'current' | 'disabled' | 'not-connected' */
  state: string;
  expiresAt?: string;
}

export async function ensureGmailWatch(auth: AuthContext): Promise<Result<WatchOutcome>> {
  const topic = env().gmailPushTopic;
  if (!topic) {
    // A deployment without push is fully functional; it syncs on the schedule
    // and on demand. Say so plainly rather than treating it as a failure.
    return ok({ state: 'disabled' });
  }

  const store = getStore();
  const integrations = (await store.list('integrations', auth.organizationId, {})) as Integration[];
  const integration = integrations.find(
    (i) => i.provider === 'google' && i.status === 'connected' && i.user_id === auth.userId,
  );
  if (!integration) return ok({ state: 'not-connected' });

  const existing = integration.watch_expires_at ? Date.parse(integration.watch_expires_at) : 0;
  const renewing = existing > 0;
  if (existing - Date.now() > RENEW_WITHIN_MS) {
    return ok({ state: 'current', expiresAt: integration.watch_expires_at ?? undefined });
  }

  const provider = new GmailProvider(store, integration);
  const watch = await provider.watch(topic);
  if (!watch.ok) {
    log.warn('Gmail watch registration failed', { code: watch.error.code });
    return err(watch.error.code, watch.error.message, { retryable: true });
  }

  await store.update('integrations', auth.organizationId, integration.id, {
    watch_expires_at: watch.value.expiresAt,
    // Only seed the cursor when there is none. Overwriting a live cursor with
    // the watch's historyId would skip everything between the last sync and
    // this registration.
    ...(integration.sync_cursor ? {} : { sync_cursor: watch.value.historyId }),
  });

  return ok({
    state: renewing ? 'renewed' : 'registered',
    expiresAt: watch.value.expiresAt,
  });
}

/**
 * Stop notifications for a mailbox being disconnected.
 *
 * Without this Gmail keeps publishing to the topic for a mailbox nobody is
 * watching, and the push endpoint answers every one of them — waking a sleeping
 * instance to do nothing. Failure is not fatal: the registration expires within
 * a week regardless.
 */
export async function stopGmailWatch(
  auth: AuthContext,
  integration: Integration,
): Promise<Result<true>> {
  const store = getStore();
  const provider = new GmailProvider(store, integration);
  const stopped = await provider.stopWatch();
  if (!stopped.ok) {
    log.warn('Gmail watch could not be stopped', { code: stopped.error.code });
  }
  await store.update('integrations', auth.organizationId, integration.id, {
    watch_expires_at: null,
  });
  return ok(true);
}
