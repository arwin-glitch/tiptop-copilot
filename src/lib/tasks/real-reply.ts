import type { EmailMessage } from '@/lib/types/domain';

/**
 * Whether a message in the mailbox really delivered something: sent (not a
 * draft), from the mailbox itself, after a given time, and not the
 * out-of-office auto-reply, a holding reply, a hand-off or a question back.
 *
 * Shared by the app's "Reply to" check (which closes a task on it) and the
 * proof check for tasks a person ticked by hand (which only clears a flag on
 * it), so both read a sent email the same way. Pure, so it imports nothing
 * from either service.
 */

export type SentMessage = Pick<
  EmailMessage,
  | 'labels'
  | 'from_address'
  | 'to_addresses'
  | 'cc_addresses'
  | 'sent_at'
  | 'subject'
  | 'snippet'
  | 'body_text'
>;

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

/** Lowercased, curly apostrophes straightened, whitespace collapsed. */
export function plainText(text: string | null | undefined): string {
  return (text ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

/** What the mailbox itself wrote in a fetched body, without the thread it quotes. */
function ownText(body: string | null | undefined): string {
  if (!body) return '';
  const text = `\n${body}`;
  const quoted = QUOTED_THREAD.exec(text);
  return plainText(quoted ? text.slice(0, quoted.index) : text);
}

/** Everyone a message went to, To and Cc, lowercased. */
export function messageRecipients(message: Pick<SentMessage, 'to_addresses' | 'cc_addresses'>) {
  return [...(message.to_addresses ?? []), ...(message.cc_addresses ?? [])].map(plainText);
}

/**
 * Whether `message` is a real send from `mailbox` after `afterMs`, to anyone.
 * Judged on Gmail's snippet (about the first 200 characters) and, when the
 * body was fetched, on the body above the quoted thread.
 */
export function isRealSend(message: SentMessage, mailbox: string, afterMs: number): boolean {
  const labels = message.labels ?? [];
  if (!labels.includes('SENT') || labels.includes('DRAFT')) return false;
  if (plainText(message.from_address) !== mailbox) return false;
  const sent = Date.parse(message.sent_at);
  if (Number.isNaN(sent) || !(sent > afterMs)) return false;
  if (plainText(message.subject).startsWith(AUTO_REPLY_SUBJECT)) return false;
  const snippet = plainText(message.snippet);
  if (snippet.startsWith(OUT_OF_OFFICE_SNIPPET) || snippet.endsWith('?')) return false;
  return !HOLDING_REPLY.test(snippet) && !HOLDING_REPLY.test(ownText(message.body_text));
}

/** Whether `message` is a real reply from `mailbox` to `sender`, sent after `afterMs`. */
export function isRealReply(
  message: SentMessage,
  mailbox: string,
  sender: string,
  afterMs: number,
): boolean {
  return messageRecipients(message).includes(sender) && isRealSend(message, mailbox, afterMs);
}
