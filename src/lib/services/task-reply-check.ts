import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { mentionsNickOnly } from '@/lib/tasks/nick-only';
import type { AuditEvent, EmailMessage, EmailThread, Integration, Task } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { localClock } from '@/lib/util/time';
import {
  CENTRAL_TIMEZONE,
  DEFAULT_MAILBOX,
  latestHumanTaskTouch,
  writeAutoClose,
} from './task-close';
import { normalizeTitle } from './task-ingest';

/**
 * The app's own check for "Reply to …" tasks made from the Inbox: once a day,
 * at or after 4pm Central, a task whose email thread now holds a real reply
 * from the mailbox is closed. Real means sent (not a draft), to the person
 * who wrote in, after the task was last touched, and not the out-of-office
 * auto-reply, a holding reply, a hand-off or a question back. A miss leaves
 * the task open, which is the safe outcome: a reply sent in a new thread, a
 * gap in the Gmail sync, or a real reply the phrase filter catches all stay
 * for a person. Nothing involving a Nick-only counterparty is checked.
 */

/** Only this mailbox's replies count; with another account connected the check does nothing. */
export const REPLY_CHECK_MAILBOX = DEFAULT_MAILBOX;
const CHECK_HOUR = 16;

const AUTO_REPLY_SUBJECT = 'slow to respond';
const OUT_OF_OFFICE_SNIPPET = "thank you for your email. i'm currently out of the office";
/** Replies that ask the sender to wait, or pass them on: the answer is still owed. */
const HOLDING_REPLY = new RegExp(
  [
    String.raw`\bflag(s|ged|ging)?\b`,
    String.raw`\bon (his|nick's) radar\b`,
    String.raw`\bpass(ed|ing)? (\w+ ){0,3}(along|on)\b`,
    String.raw`\bmake sure (he|nick) (sees|gets|has)\b`,
    String.raw`\bsend .{1,40} a note\b`,
    String.raw`\bcan'?t speak to\b`,
    String.raw`\bloop(ed|ing)? in\b`,
    String.raw`\barwin here\b`,
    String.raw`\bnick's ea\b`,
    String.raw`\bhe'?ll (follow up|get back|reach out|be in touch|respond|reply)\b`,
    String.raw`\bhe (may|will|can) (follow up|get back|reach out|respond|reply)\b`,
    String.raw`\bget back to you\b`,
    String.raw`\bcircle back\b`,
    String.raw`\bkeep you posted\b`,
    String.raw`\blet me check\b`,
    String.raw`\bout of (the )?office\b`,
    String.raw`\b(away|out) until\b`,
    String.raw`\bon (paternity |parental )?leave\b`,
    String.raw`\b(could|can) you (please )?(re-?send|share)\b`,
  ].join('|'),
  'i',
);
/** Where a plain-text reply's quoted thread starts. */
const QUOTED_THREAD =
  /\n\s*(on [^\n]{0,200}(\n[^\n]{0,200})?wrote:|>|-{2,} ?original message|from: )/i;

function plain(text: string | null | undefined): string {
  return (text ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

/** What the mailbox itself wrote in a fetched body, without the thread it quotes. */
function ownText(body: string | null | undefined): string {
  if (!body) return '';
  const text = `\n${body}`;
  const quoted = QUOTED_THREAD.exec(text);
  return plain(quoted ? text.slice(0, quoted.index) : text);
}

/** The Central date, and whether it is 4pm or later there. */
export function replyCheckClock(now: Date): { localDate: string; due: boolean } {
  const clock = localClock(now, CENTRAL_TIMEZONE);
  return { localDate: clock.dateKey, due: clock.hour >= CHECK_HOUR };
}

/**
 * Whether `message` is a real reply from `mailbox` to `sender`, sent after
 * `afterMs`. Judged on Gmail's snippet (about the first 200 characters) and,
 * when the body was fetched, on the body above the quoted thread.
 */
export function isRealReply(
  message: Pick<
    EmailMessage,
    | 'labels'
    | 'from_address'
    | 'to_addresses'
    | 'cc_addresses'
    | 'sent_at'
    | 'subject'
    | 'snippet'
    | 'body_text'
  >,
  mailbox: string,
  sender: string,
  afterMs: number,
): boolean {
  const labels = message.labels ?? [];
  if (!labels.includes('SENT') || labels.includes('DRAFT')) return false;
  if (plain(message.from_address) !== mailbox) return false;
  const sent = Date.parse(message.sent_at);
  if (Number.isNaN(sent) || !(sent > afterMs)) return false;
  const recipients = [...(message.to_addresses ?? []), ...(message.cc_addresses ?? [])].map(plain);
  if (!recipients.includes(sender)) return false;
  if (plain(message.subject).startsWith(AUTO_REPLY_SUBJECT)) return false;
  const snippet = plain(message.snippet);
  if (snippet.startsWith(OUT_OF_OFFICE_SNIPPET) || snippet.endsWith('?')) return false;
  return !HOLDING_REPLY.test(snippet) && !HOLDING_REPLY.test(ownText(message.body_text));
}

export type ReplyCheckState =
  'off' | 'not_yet' | 'done_today' | 'no_mailbox' | 'wrong_mailbox' | 'ran' | 'error';

export interface ReplyCheckOutcome {
  state: ReplyCheckState;
  localDate: string;
  checked: number;
  closed: number;
}

/** The Central date each organization's check last ran, so a quiet pull costs no query. */
const sweptOn = processWide('task-reply-check', () => new Map<string, string>());

async function sweptToday(
  store: DataStore,
  organizationId: string,
  localDate: string,
): Promise<boolean> {
  if (sweptOn.get(organizationId) === localDate) return true;
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: 'task.autoclose_sweep', entity_id: organizationId } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  if (rows[0]?.metadata?.local_date === localDate) {
    sweptOn.set(organizationId, localDate);
    return true;
  }
  return false;
}

async function connectedMailbox(store: DataStore, organizationId: string): Promise<string | null> {
  const rows = (await store.list(
    'integrations',
    organizationId,
    { eq: { provider: 'google' } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as Integration[];
  return rows[0]?.account_email ? plain(rows[0].account_email) : null;
}

/**
 * Runs the check at most once per Central day, in the first call at or after
 * 4pm Central. `enabled` is `TASK_REPLY_AUTOCLOSE` (on unless set to off).
 */
export async function runReplyCheck(
  store: DataStore,
  organizationId: string,
  opts: { now?: Date; enabled: boolean },
): Promise<ReplyCheckOutcome> {
  const now = opts.now ?? new Date();
  const { localDate, due } = replyCheckClock(now);
  const outcome = (state: ReplyCheckState, checked = 0, closed = 0): ReplyCheckOutcome => ({
    state,
    localDate,
    checked,
    closed,
  });
  if (!opts.enabled) return outcome('off');
  if (!due) return outcome('not_yet');
  if (await sweptToday(store, organizationId, localDate)) return outcome('done_today');

  const mailbox = await connectedMailbox(store, organizationId);
  if (!mailbox) return outcome('no_mailbox');
  if (mailbox !== REPLY_CHECK_MAILBOX) return outcome('wrong_mailbox');

  const open = (await listAllPages(store, 'tasks', organizationId, {
    in: { status: ['open', 'snoozed'] },
    notNull: ['email_message_id'],
  })) as Task[];
  const tasks = open.filter(
    (t) => normalizeTitle(t.title).startsWith('reply to ') && !mentionsNickOnly(t.title, t.detail),
  );

  let closed = 0;
  for (const task of tasks) {
    const source = (await store.get(
      'email_messages',
      organizationId,
      task.email_message_id!,
    )) as EmailMessage | null;
    if (!source) continue;
    const sender = plain(source.from_address);
    if (!sender || sender === mailbox) continue;
    if (
      mentionsNickOnly(
        source.from_address,
        source.subject,
        ...(source.to_addresses ?? []),
        ...(source.cc_addresses ?? []),
      )
    ) {
      continue;
    }

    const touched = await latestHumanTaskTouch(store, organizationId, task);
    const afterMs = Math.max(
      Date.parse(source.sent_at),
      touched ? Date.parse(touched) : Number.NEGATIVE_INFINITY,
    );
    if (Number.isNaN(afterMs)) continue;

    const thread = (await store.list(
      'email_messages',
      organizationId,
      { eq: { thread_id: source.thread_id } },
      { orderBy: [{ field: 'sent_at', direction: 'asc' }] },
    )) as EmailMessage[];
    const reply = thread.find((m) => isRealReply(m, mailbox, sender, afterMs));
    if (!reply) continue;

    const threadRow = (await store.get(
      'email_threads',
      organizationId,
      source.thread_id,
    )) as EmailThread | null;
    const done = await writeAutoClose(
      store,
      organizationId,
      task.id,
      {
        source: 'app-reply-check',
        match: 'thread',
        kind: 'reply',
        evidence_type: 'gmail_sent',
        evidence_id: reply.provider_message_id,
        thread_id: threadRow?.provider_thread_id ?? null,
        evidence_at: new Date(Date.parse(reply.sent_at)).toISOString(),
        reason: 'Reply sent in the same email thread',
        slack_ts: null,
      },
      now,
    );
    if (done === 'closed') closed++;
  }

  await recordAudit(store, {
    organizationId,
    userId: null,
    action: 'task.autoclose_sweep',
    entityType: 'organization',
    entityId: organizationId,
    metadata: { local_date: localDate, checked: tasks.length, closed },
  });
  sweptOn.set(organizationId, localDate);
  if (closed > 0) log.info('Reply check closed tasks', { checked: tasks.length, closed });
  return outcome('ran', tasks.length, closed);
}

/** Test seam: forget which days have been checked. */
export function resetReplyCheckState(): void {
  sweptOn.clear();
}
