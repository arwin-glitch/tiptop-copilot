import 'server-only';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { checkWakeAt, SNOOZE_NOT_SET_UP } from '@/lib/email/snooze';
import { gmailFailCode } from '@/lib/google/gmail-get';
import { canSend, setThreadLabels } from '@/lib/google/gmail-send';
import { log } from '@/lib/security/redact';
import type { InboxSnooze, Integration } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';

/**
 * Snooze for the Inbox tab. Gmail's API has no snooze, so Kraken keeps it:
 *
 * - Snooze takes INBOX off the thread in Gmail (the same change as Archive)
 *   and keeps one `inbox_snoozes` row with the wake time; snoozing a thread
 *   again replaces its open row.
 * - Unsnooze (and the toast's Undo) puts INBOX back at once and cancels the
 *   row.
 * - Waking, at or after the wake time, puts INBOX and UNREAD back and marks
 *   the row woken. It runs when the Inbox list loads and on the daily job's
 *   runs, and touches only threads someone snoozed from the Inbox. A thread
 *   Gmail no longer has is marked woken too; any other failure is left for
 *   the next run.
 *
 * Nothing is deleted or trashed, and only INBOX and UNREAD are ever written.
 * In demo mode the rows alone carry it (no Gmail). Without the table (its
 * migration not run yet) Snooze says it needs a database update, nothing is
 * taken out of the inbox, and waking does nothing.
 */

/** The Gmail id shape the routes take (lower-cased before it is stored). */
export const SNOOZE_THREAD_ID = /^[0-9a-f]{10,24}$/i;
/** Threads one tap may snooze or unsnooze at once (the bulk bar's selection). */
export const MAX_SNOOZE_IDS = 100;
/** Due snoozes one wake pass handles; the rest wait for the next. */
const WAKE_BATCH = 50;

export interface SnoozeActor {
  organizationId: string;
  userId: string | null;
  /** The mailbox to change, or null; ignored in demo mode. */
  integration: Integration | null;
  demo: boolean;
}

const needsMigration = () =>
  err('not_configured', SNOOZE_NOT_SET_UP, { details: { needsMigration: true } });

const cannotChange = () =>
  err('forbidden', 'Snoozing from the app needs sending turned on. Do it in Gmail instead.');

/** The open snoozes, soonest wake first; or that the table is not there yet. */
export async function readOpenSnoozes(
  store: DataStore,
  organizationId: string,
): Promise<{ state: 'ok' | 'needs_migration'; rows: InboxSnooze[] }> {
  try {
    const rows = (await store.list(
      'inbox_snoozes',
      organizationId,
      { eq: { status: 'snoozed' } },
      { orderBy: [{ field: 'wake_at', direction: 'asc' }], limit: 500 },
    )) as InboxSnooze[];
    return { state: 'ok', rows };
  } catch (error) {
    if (isMissingTableError(error)) return { state: 'needs_migration', rows: [] };
    throw error;
  }
}

/** Whether the table is there: one cheap read before anything changes in Gmail. */
async function tableReady(store: DataStore, organizationId: string): Promise<boolean> {
  try {
    await store.list('inbox_snoozes', organizationId, { eq: { status: 'snoozed' } }, { limit: 1 });
    return true;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

/** Close a thread's open snooze, if it has one. */
async function closeOpen(
  store: DataStore,
  organizationId: string,
  threadId: string,
  status: 'woken' | 'cancelled',
): Promise<void> {
  await store.updateWhere(
    'inbox_snoozes',
    organizationId,
    { eq: { thread_id: threadId, status: 'snoozed' } },
    { status, updated_at: new Date().toISOString() },
  );
}

/**
 * Snooze threads until `wakeAt`. Each thread leaves the inbox in Gmail first
 * and gets its row only once Gmail took it, so a refusal leaves nothing
 * half-done. Returns the ids snoozed.
 */
export async function snoozeThreads(
  store: DataStore,
  actor: SnoozeActor,
  ids: readonly string[],
  wakeAt: string,
  now: Date = new Date(),
): Promise<Result<{ ids: string[]; wakeAt: string }>> {
  const wake = checkWakeAt(wakeAt, now);
  if (!wake.ok) return err('invalid_input', wake.message);
  const threadIds = cleanIds(ids);
  if (!threadIds) return err('invalid_input', 'Nothing to snooze.');
  if (!actor.demo && (!actor.integration || !canSend(actor.integration))) return cannotChange();
  if (!(await tableReady(store, actor.organizationId))) return needsMigration();

  const iso = wake.at.toISOString();
  const done: string[] = [];
  for (const id of threadIds) {
    if (!actor.demo) {
      const res = await setThreadLabels(store, actor.integration!, id, { remove: ['INBOX'] });
      if (!res.ok) continue;
    }
    try {
      await closeOpen(store, actor.organizationId, id, 'cancelled');
      const stamp = now.toISOString();
      await store.insert('inbox_snoozes', {
        id: newId(),
        organization_id: actor.organizationId,
        thread_id: id,
        wake_at: iso,
        status: 'snoozed',
        created_by: actor.userId,
        created_at: stamp,
        updated_at: stamp,
      });
      done.push(id);
    } catch {
      // Out of the inbox with no row would never come back: put it back.
      log.warn('A snooze could not be stored; the thread goes back to the inbox');
      if (!actor.demo) await setThreadLabels(store, actor.integration!, id, { add: ['INBOX'] });
    }
  }
  if (done.length === 0) {
    return err(
      actor.demo ? 'internal' : 'provider_unavailable',
      'Gmail did not take that. Try again.',
    );
  }
  return ok({ ids: done, wakeAt: iso });
}

/** Back to the inbox now: INBOX goes back on in Gmail and the open row is cancelled. */
export async function unsnoozeThreads(
  store: DataStore,
  actor: SnoozeActor,
  ids: readonly string[],
): Promise<Result<{ ids: string[] }>> {
  const threadIds = cleanIds(ids);
  if (!threadIds) return err('invalid_input', 'Nothing to unsnooze.');
  if (!actor.demo && (!actor.integration || !canSend(actor.integration))) return cannotChange();
  if (!(await tableReady(store, actor.organizationId))) return needsMigration();

  const done: string[] = [];
  for (const id of threadIds) {
    if (!actor.demo) {
      const res = await setThreadLabels(store, actor.integration!, id, { add: ['INBOX'] });
      if (!res.ok) continue;
    }
    await closeOpen(store, actor.organizationId, id, 'cancelled');
    done.push(id);
  }
  if (done.length === 0) {
    return err('provider_unavailable', 'Gmail did not take that. Try again.');
  }
  return ok({ ids: done });
}

export interface WakeSummary {
  state: 'ok' | 'needs_migration' | 'not_connected' | 'failed';
  /** Threads put back in the inbox this pass. */
  woken: string[];
  /** Due threads Gmail refused this time, left for the next pass. */
  failed: number;
}

/**
 * Put every due snooze back: INBOX and UNREAD on in Gmail, the row woken.
 * Best-effort and never throws. `integration` undefined reads the
 * organization's mailbox.
 */
export async function wakeDueSnoozes(
  store: DataStore,
  organizationId: string,
  options: { demo: boolean; integration?: Integration | null; now?: Date },
): Promise<WakeSummary> {
  const now = options.now ?? new Date();
  try {
    const due = (await store.list(
      'inbox_snoozes',
      organizationId,
      { eq: { status: 'snoozed' }, lte: { wake_at: now.toISOString() } },
      { orderBy: [{ field: 'wake_at', direction: 'asc' }], limit: WAKE_BATCH },
    )) as InboxSnooze[];
    if (due.length === 0) return { state: 'ok', woken: [], failed: 0 };

    let integration: Integration | null = null;
    if (!options.demo) {
      integration =
        options.integration === undefined
          ? await getPrimaryIntegration(store, organizationId).catch(() => null)
          : options.integration;
      if (!integration || integration.status === 'disconnected' || !canSend(integration)) {
        return { state: 'not_connected', woken: [], failed: due.length };
      }
    }

    const woken: string[] = [];
    let failed = 0;
    for (const row of due) {
      if (integration) {
        const res = await setThreadLabels(store, integration, row.thread_id, {
          add: ['INBOX', 'UNREAD'],
        });
        // A thread Gmail no longer has can never wake: close its row too.
        if (!res.ok && gmailFailCode(res.error) !== 'not_found') {
          failed++;
          continue;
        }
      }
      await store.update('inbox_snoozes', organizationId, row.id, {
        status: 'woken',
        updated_at: now.toISOString(),
      });
      woken.push(row.thread_id);
    }
    return { state: 'ok', woken, failed };
  } catch (error) {
    if (isMissingTableError(error)) return { state: 'needs_migration', woken: [], failed: 0 };
    log.warn('Waking snoozed threads failed', { reason: (error as Error)?.message?.slice(0, 120) });
    return { state: 'failed', woken: [], failed: 0 };
  }
}

/** The daily job's line: counts only (the response lands in a public log). */
export function formatSnoozeCronStatus(summary: WakeSummary): string {
  switch (summary.state) {
    case 'needs_migration':
      return 'skipped: needs database update';
    case 'not_connected':
      return `skipped: not_connected (${summary.failed} due)`;
    case 'failed':
      return 'failed';
    default:
      return `ok: ${summary.woken.length} woken${summary.failed ? `, ${summary.failed} left for the next run` : ''}`;
  }
}

/** Distinct, well-formed, lower-cased ids; null for none or too many. */
function cleanIds(ids: readonly string[]): string[] | null {
  if (ids.length === 0 || ids.length > MAX_SNOOZE_IDS) return null;
  if (ids.some((id) => !SNOOZE_THREAD_ID.test(id))) return null;
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}
