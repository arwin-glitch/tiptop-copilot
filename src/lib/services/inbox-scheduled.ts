import 'server-only';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { displayName } from '@/lib/google/gmail-inbox';
import { canSend, readPrimarySignature, sendComposed } from '@/lib/google/gmail-send';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { MAX_COMPOSE_HTML, sanitizeComposeHtml } from '@/lib/email/compose-html';
import { checkSendAt, SCHEDULE_NOT_SET_UP } from '@/lib/email/schedule-send';
import { log } from '@/lib/security/redact';
import type { InboxScheduledSend, Integration, Organization } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import type { LiveThreadRow } from './inbox-live';

/**
 * Schedule send for the Inbox tab. Gmail's API has no scheduled send, so
 * Kraken keeps the email (inbox_scheduled_sends) and sends it at its time.
 *
 * The rules this module keeps:
 * - A row exists only because a person picked a time in the compose window:
 *   that pick is the send decision. Nothing here writes an email.
 * - At most once. A due row is claimed with one compare-and-set update
 *   (status 'scheduled' -> 'sending', with a fresh claim token); only the
 *   caller whose update matched sends. Two runners racing (the minute loop
 *   and an Inbox page load) get one winner.
 * - Never after a cancel: cancelling is the same compare-and-set
 *   ('scheduled' -> 'cancelled'), so a cancel and a claim cannot both win.
 * - A row left in 'sending' (the process died mid-send) is never sent again:
 *   after STALE_SENDING_MS it is marked 'failed' with a note to check Sent.
 *   A failed send Gmail refused for a passing reason goes back to
 *   'scheduled' for the next pass, up to MAX_ATTEMPTS; never as Nick without
 *   his real Gmail signature.
 * - Before its migration is run, every call says it needs a database update
 *   and nothing is stored or sent.
 *
 * Who runs it: the phone-alert job's minute loop (GET /api/cron/push), the
 * daily job, and the Inbox list as it loads (lib/email/schedule-send.ts).
 */

const TABLE = 'inbox_scheduled_sends' as const;
/** Due sends one pass handles; the rest wait for the next minute. */
const DISPATCH_BATCH = 10;
export const MAX_ATTEMPTS = 5;
/** A claim older than this never finished: it is marked failed, never sent again. */
export const STALE_SENDING_MS = 15 * 60_000;

export interface ScheduledContent {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  signature: 'nick' | 'arwin';
  threadId?: string | null;
  forwardOf?: string | null;
}

export interface ScheduleActor {
  organizationId: string;
  userId: string | null;
  integration: Integration | null;
  demo: boolean;
}

const needsMigration = () =>
  err('not_configured', SCHEDULE_NOT_SET_UP, { details: { needsMigration: true } });

const gone = () =>
  err('conflict', 'That email already went out or was cancelled. Refresh to see it.');

/** Whether the table is there: one cheap read before anything is stored. */
export async function scheduleTableReady(
  store: DataStore,
  organizationId: string,
): Promise<boolean> {
  try {
    await store.list(TABLE, organizationId, { eq: { status: 'scheduled' } }, { limit: 1 });
    return true;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

function rowFor(s: InboxScheduledSend): LiveThreadRow {
  const to = [s.to_addresses, s.cc_addresses, s.bcc_addresses]
    .join(',')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(displayName);
  const text = s.body_html
    .replace(/<\/(div|p|li)>|<br>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id: s.id,
    kind: 'scheduled',
    scheduledId: s.id,
    sendAt: s.send_at,
    who: to.length ? to.join(', ') : '(no recipients)',
    subject: s.subject || '(no subject)',
    snippet: s.status === 'sending' ? `Sending now… ${text}` : text.slice(0, 160),
    at: s.send_at,
    unread: false,
    starred: false,
    inInbox: false,
    labels: [],
    labelIds: [],
    lastFromUs: true,
    flagged: false,
  };
}

/** The Scheduled folder: what goes out later (and what is going now), soonest first. */
export async function listScheduledRows(
  store: DataStore,
  organizationId: string,
): Promise<{ state: 'ok' | 'needs_migration'; rows: LiveThreadRow[] }> {
  try {
    const rows = (await store.list(
      TABLE,
      organizationId,
      { in: { status: ['scheduled', 'sending'] } },
      { orderBy: [{ field: 'send_at', direction: 'asc' }], limit: 200 },
    )) as InboxScheduledSend[];
    return { state: 'ok', rows: rows.map(rowFor) };
  } catch (error) {
    if (isMissingTableError(error)) return { state: 'needs_migration', rows: [] };
    throw error;
  }
}

/** The nav's count: null before the migration (or on a failed read). */
export async function countScheduled(
  store: DataStore,
  organizationId: string,
): Promise<number | null> {
  try {
    return await store.count(TABLE, organizationId, { eq: { status: 'scheduled' } });
  } catch {
    return null;
  }
}

/** One scheduled send, to open it in the compose window. */
export async function readScheduled(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<InboxScheduledSend>> {
  try {
    const row = (await store.get(TABLE, organizationId, id)) as InboxScheduledSend | null;
    return row ? ok(row) : err('not_found', 'That scheduled email is gone.');
  } catch (error) {
    if (isMissingTableError(error)) return needsMigration();
    throw error;
  }
}

function contentPatch(c: ScheduledContent) {
  return {
    to_addresses: c.to.slice(0, 4000),
    cc_addresses: c.cc.slice(0, 4000),
    bcc_addresses: c.bcc.slice(0, 4000),
    subject: c.subject.slice(0, 300),
    body_html: sanitizeComposeHtml(c.html).slice(0, MAX_COMPOSE_HTML),
    signature: c.signature,
    thread_id: c.threadId ? c.threadId.toLowerCase() : null,
    forward_of: c.forwardOf ? c.forwardOf.toLowerCase() : null,
  };
}

function allowed(actor: ScheduleActor): boolean {
  return actor.demo || Boolean(actor.integration && canSend(actor.integration));
}

const notAllowed = () =>
  err('forbidden', 'Schedule send needs sending turned on. Schedule it in Gmail instead.');

/** Keep an email to send at `sendAt`: the person's Schedule pick. Sends nothing now. */
export async function scheduleSend(
  store: DataStore,
  actor: ScheduleActor,
  content: ScheduledContent,
  sendAt: string,
  now: Date = new Date(),
): Promise<Result<InboxScheduledSend>> {
  const when = checkSendAt(sendAt, now);
  if (!when.ok) return err('invalid_input', when.message);
  if (!allowed(actor)) return notAllowed();
  if (!(await scheduleTableReady(store, actor.organizationId))) return needsMigration();
  const stamp = now.toISOString();
  const row: InboxScheduledSend = {
    id: newId(),
    organization_id: actor.organizationId,
    created_by: actor.userId,
    status: 'scheduled',
    send_at: when.at.toISOString(),
    ...contentPatch(content),
    claim_token: null,
    claimed_at: null,
    attempts: 0,
    sent_at: null,
    sent_message_id: null,
    last_error: null,
    created_at: stamp,
    updated_at: stamp,
  };
  return ok((await store.insert(TABLE, row)) as InboxScheduledSend);
}

/** Change a scheduled email or its time, only while it is still waiting. */
export async function updateScheduled(
  store: DataStore,
  actor: ScheduleActor,
  id: string,
  content: ScheduledContent,
  sendAt: string,
  now: Date = new Date(),
): Promise<Result<InboxScheduledSend>> {
  const when = checkSendAt(sendAt, now);
  if (!when.ok) return err('invalid_input', when.message);
  if (!allowed(actor)) return notAllowed();
  if (!(await scheduleTableReady(store, actor.organizationId))) return needsMigration();
  const [row] = (await store.updateWhere(
    TABLE,
    actor.organizationId,
    { eq: { id, status: 'scheduled' } },
    { ...contentPatch(content), send_at: when.at.toISOString(), updated_at: now.toISOString() },
  )) as InboxScheduledSend[];
  return row ? ok(row) : gone();
}

/**
 * Cancel a scheduled email, only while it is still waiting: the same
 * compare-and-set a send's claim uses, so a cancel and a send never both
 * win. Returns the email, so it can go back to Drafts.
 */
export async function cancelScheduled(
  store: DataStore,
  actor: ScheduleActor,
  id: string,
  now: Date = new Date(),
): Promise<Result<InboxScheduledSend>> {
  if (!(await scheduleTableReady(store, actor.organizationId))) return needsMigration();
  const [row] = (await store.updateWhere(
    TABLE,
    actor.organizationId,
    { eq: { id, status: 'scheduled' } },
    { status: 'cancelled', updated_at: now.toISOString() },
  )) as InboxScheduledSend[];
  return row ? ok(row) : gone();
}

export type Sender = (
  store: DataStore,
  integration: Integration,
  row: InboxScheduledSend,
) => Promise<Result<{ messageId: string }>>;

/** The real send: the person's own words, with Nick's real Gmail signature or Arwin's. */
const gmailSender: Sender = async (store, integration, row) => {
  const signatureHtml =
    row.signature === 'arwin'
      ? ARWIN_SIGNATURE_HTML
      : await readPrimarySignature(store, integration);
  if (!signatureHtml) {
    return err('provider_unavailable', "Couldn't read Nick's signature from Gmail.", {
      retryable: true,
    });
  }
  const sent = await sendComposed(store, integration, {
    to: row.to_addresses,
    cc: row.cc_addresses,
    bcc: row.bcc_addresses,
    subject: row.subject || '(no subject)',
    body: '',
    html: row.body_html,
    threadId: row.thread_id,
    forwardMessageId: row.forward_of,
    attachments: [],
    signatureHtml,
  });
  if (sent.ok) return ok({ messageId: sent.value.messageId });
  // Once the send request has left, a dropped connection or a Gmail error can
  // still mean the email went out. Never retry it: it is marked failed and the
  // person is told to check Sent, so an email can never go twice.
  return err(sent.error.code, sent.error.message);
};

/** Claim one waiting row for this caller alone. Null when someone else has it, or it was cancelled. */
async function claim(
  store: DataStore,
  organizationId: string,
  row: InboxScheduledSend,
  now: Date,
  extra: Partial<InboxScheduledSend> = {},
  dueOnly = true,
): Promise<InboxScheduledSend | null> {
  const token = newId();
  const filter = dueOnly
    ? { eq: { id: row.id, status: 'scheduled' }, lte: { send_at: now.toISOString() } }
    : { eq: { id: row.id, status: 'scheduled' } };
  const [claimed] = (await store.updateWhere(TABLE, organizationId, filter, {
    ...extra,
    status: 'sending',
    claim_token: token,
    claimed_at: now.toISOString(),
    attempts: row.attempts + 1,
    updated_at: now.toISOString(),
  })) as InboxScheduledSend[];
  return claimed && claimed.claim_token === token ? claimed : null;
}

/** Send a claimed row and record what happened. Never throws. */
async function deliver(
  store: DataStore,
  organizationId: string,
  integration: Integration,
  row: InboxScheduledSend,
  send: Sender,
  now: Date,
): Promise<'sent' | 'retry' | 'failed'> {
  let res: Result<{ messageId: string }>;
  try {
    res = await send(store, integration, row);
  } catch {
    res = err('internal', 'The send failed unexpectedly.');
  }
  const stamp = new Date().toISOString();
  if (res.ok) {
    await store.updateWhere(
      TABLE,
      organizationId,
      { eq: { id: row.id, claim_token: row.claim_token } },
      { status: 'sent', sent_at: stamp, sent_message_id: res.value.messageId, updated_at: stamp },
    );
    return 'sent';
  }
  // Refused before anything went out (a bad address, a Gmail hiccup): try
  // again next pass while attempts last; otherwise it stops, failed.
  const again = res.error.retryable === true && row.attempts < MAX_ATTEMPTS;
  await store.updateWhere(
    TABLE,
    organizationId,
    { eq: { id: row.id, claim_token: row.claim_token } },
    {
      status: again ? 'scheduled' : 'failed',
      claim_token: null,
      last_error: res.error.message.slice(0, 300),
      updated_at: stamp,
    },
  );
  void now;
  return again ? 'retry' : 'failed';
}

export interface DispatchSummary {
  state: 'ok' | 'needs_migration' | 'not_connected' | 'skipped' | 'failed';
  sent: number;
  retry: number;
  failed: number;
}

/**
 * Send every scheduled email that is due, once each. Best-effort and never
 * throws. Demo mode sends nothing (the demo has no mailbox): its rows wait.
 */
export async function dispatchDueScheduled(
  store: DataStore,
  organizationId: string,
  options: { demo: boolean; integration?: Integration | null; now?: Date; send?: Sender },
): Promise<DispatchSummary> {
  const now = options.now ?? new Date();
  const summary: DispatchSummary = { state: 'ok', sent: 0, retry: 0, failed: 0 };
  if (options.demo) return { ...summary, state: 'skipped' };
  try {
    // A claim that never finished is closed as failed, and never sent again.
    const stale = (await store.updateWhere(
      TABLE,
      organizationId,
      {
        eq: { status: 'sending' },
        lt: { claimed_at: new Date(now.getTime() - STALE_SENDING_MS).toISOString() },
      },
      {
        status: 'failed',
        last_error: 'The send was interrupted. Check Sent in Gmail before sending it again.',
        updated_at: now.toISOString(),
      },
    )) as InboxScheduledSend[];
    if (stale.length)
      log.warn('Scheduled sends left mid-send were closed', { count: stale.length });

    const due = (await store.list(
      TABLE,
      organizationId,
      { eq: { status: 'scheduled' }, lte: { send_at: now.toISOString() } },
      { orderBy: [{ field: 'send_at', direction: 'asc' }], limit: DISPATCH_BATCH },
    )) as InboxScheduledSend[];
    if (due.length === 0) return summary;

    const integration =
      options.integration === undefined
        ? await getPrimaryIntegration(store, organizationId).catch(() => null)
        : options.integration;
    if (!integration || integration.status === 'disconnected' || !canSend(integration)) {
      return { ...summary, state: 'not_connected' };
    }
    const send = options.send ?? gmailSender;
    for (const row of due) {
      const mine = await claim(store, organizationId, row, now);
      if (!mine) continue;
      const outcome = await deliver(store, organizationId, integration, mine, send, now);
      summary[outcome === 'sent' ? 'sent' : outcome === 'retry' ? 'retry' : 'failed']++;
    }
    return summary;
  } catch (error) {
    if (isMissingTableError(error)) return { ...summary, state: 'needs_migration' };
    log.warn('Sending scheduled emails failed', {
      reason: (error as Error)?.message?.slice(0, 120),
    });
    return { ...summary, state: 'failed' };
  }
}

/** Every organization's due sends: the minute loop and the daily job call this. */
export async function dispatchDueScheduledForAll(
  store: DataStore,
  options: { demo: boolean; now?: Date },
): Promise<DispatchSummary> {
  const total: DispatchSummary = { state: 'ok', sent: 0, retry: 0, failed: 0 };
  if (options.demo) return { ...total, state: 'skipped' };
  const organizations = (await store.list('organizations', '', {})) as Organization[];
  for (const org of organizations) {
    const one = await dispatchDueScheduled(store, org.id, { demo: false, now: options.now });
    if (one.state === 'needs_migration') return { ...total, state: 'needs_migration' };
    total.sent += one.sent;
    total.retry += one.retry;
    total.failed += one.failed;
  }
  return total;
}

/**
 * "Send now" on a scheduled email: claimed like a due one (so the loop
 * cannot send it too), with the window's latest words, then sent at once.
 */
export async function sendScheduledNow(
  store: DataStore,
  actor: ScheduleActor,
  id: string,
  content: ScheduledContent,
  options: { now?: Date; send?: Sender } = {},
): Promise<Result<true>> {
  const now = options.now ?? new Date();
  if (actor.demo) return err('forbidden', 'Nothing is sent in the demo.');
  if (!actor.integration || !canSend(actor.integration)) return notAllowed();
  if (!(await scheduleTableReady(store, actor.organizationId))) return needsMigration();
  const row = (await store.get(TABLE, actor.organizationId, id)) as InboxScheduledSend | null;
  if (!row) return gone();
  const mine = await claim(store, actor.organizationId, row, now, contentPatch(content), false);
  if (!mine) return gone();
  const outcome = await deliver(
    store,
    actor.organizationId,
    actor.integration,
    mine,
    options.send ?? gmailSender,
    now,
  );
  if (outcome === 'sent') return ok(true);
  const after = (await store.get(TABLE, actor.organizationId, id)) as InboxScheduledSend | null;
  return err('provider_unavailable', after?.last_error ?? 'It did not send. Try again.', {
    retryable: outcome === 'retry',
  });
}

/** The daily job's line: counts only (the response lands in a public log). */
export function formatScheduledCronStatus(summary: DispatchSummary): string {
  switch (summary.state) {
    case 'needs_migration':
      return 'skipped: needs database update';
    case 'skipped':
      return 'skipped: demo';
    case 'failed':
      return 'failed';
    default:
      return `ok: ${summary.sent} sent${summary.retry ? `, ${summary.retry} to retry` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}`;
  }
}
