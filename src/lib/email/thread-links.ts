import { gmailThreadUrl } from '@/lib/deals/links';

/**
 * Where an email link goes. Every email or thread link in the app offers two
 * places to read it: "Copilot", the Inbox's reading pane at
 * `/inbox?thread=<id>`, and "Gmail", the thread in Gmail in the browser. Both
 * are rebuilt from a validated id, never from a stored URL.
 *
 * The id is either Gmail's own (a thread's or a message's, hex: Gmail opens
 * either, and the Inbox resolves a message id to its thread on the server),
 * or Copilot's id for an email it synced (a UUID, as Today, a deal's sources
 * and citations hold). A synced id is looked up on the server: the Inbox
 * opens its conversation, and `&open=gmail` sends the browser on to Gmail.
 *
 * Pure and client-safe; the two links themselves are
 * `src/components/email/thread-links.tsx`.
 */

const GMAIL_ID = /^[0-9a-f]{10,24}$/i;
const SYNCED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Inbox's URL parameter for one conversation to open. */
export const INBOX_THREAD_PARAM = 'thread';
/** An older name for the same parameter, still in saved links (briefs, bookmarks). */
export const INBOX_MESSAGE_PARAM = 'message';
/** `open=gmail` on an Inbox link: go on to the conversation in Gmail. */
export const INBOX_OPEN_PARAM = 'open';

/** Whether a value is a Gmail thread or message id (hex). */
export function isGmailId(id: unknown): id is string {
  return typeof id === 'string' && GMAIL_ID.test(id);
}

/** Whether a value is Copilot's own id for a synced email or thread (a UUID). */
export function isSyncedEmailId(id: unknown): id is string {
  return typeof id === 'string' && SYNCED_ID.test(id);
}

/** Whether a value is any id an email link can carry. */
export function isEmailLinkId(id: unknown): id is string {
  return isGmailId(id) || isSyncedEmailId(id);
}

/**
 * The conversation in Copilot's Inbox, or null for anything that is neither a
 * Gmail id nor a synced email's id.
 */
export function copilotThreadHref(id: string | null | undefined): string | null {
  return isEmailLinkId(id) ? `/inbox?${INBOX_THREAD_PARAM}=${id.toLowerCase()}` : null;
}

/**
 * Both places to read one email: null when the id is not one an email link
 * can carry. A Gmail id with its mailbox goes straight to Gmail. A synced
 * email's id, or a Gmail id with no mailbox known where the link is drawn,
 * goes by way of the Inbox (`&open=gmail`), which looks up the Gmail id and
 * the connected mailbox and sends the browser on: Gmail's `/u/0/` would open
 * whichever account the browser signed in first.
 */
export function threadLinks(
  id: string | null | undefined,
  mailbox: string | null | undefined,
): { copilot: string; gmail: string } | null {
  const copilot = copilotThreadHref(id);
  if (!copilot || !id) return null;
  if (isSyncedEmailId(id) || !mailbox) {
    return { copilot, gmail: `${copilot}&${INBOX_OPEN_PARAM}=gmail` };
  }
  const gmail = gmailThreadUrl(id, mailbox);
  return gmail ? { copilot, gmail } : null;
}

/**
 * The id to link a synced email by: Gmail's own message id when it has one,
 * so Gmail opens without a stop in the app, else Copilot's id for it (the
 * demo's fictional emails, or a provider id that is not Gmail's).
 */
export function emailLinkId(message: { id: string; provider_message_id?: string | null }): string {
  return isGmailId(message.provider_message_id) ? message.provider_message_id : message.id;
}

/**
 * The id an Inbox URL asks to open: `?thread=<id>` (or the older
 * `?message=<id>`). Null when the URL asks for none; anything that is not an
 * id a link can carry comes back as given, so the page can say it could not
 * open it rather than ignore the link.
 */
export function inboxThreadParam(
  params: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const first = (raw: string | string[] | undefined) =>
    (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
  const value = first(params[INBOX_THREAD_PARAM]) ?? first(params[INBOX_MESSAGE_PARAM]);
  if (!value) return null;
  return GMAIL_ID.test(value) || SYNCED_ID.test(value) ? value.toLowerCase() : value.slice(0, 100);
}

/**
 * The email an in-app Inbox link (`/inbox?thread=<id>`, or an older
 * `/inbox?message=<id>`) opens, for a place that stored the link rather than
 * the id (a brief's items). Null for any other link.
 */
export function emailIdFromInboxHref(href: string | null | undefined): string | null {
  if (!href?.startsWith('/inbox?')) return null;
  const params = Object.fromEntries(new URLSearchParams(href.slice('/inbox?'.length)));
  const id = inboxThreadParam(params);
  return isEmailLinkId(id) ? id : null;
}

/** Whether an Inbox URL asks to go on to Gmail (`&open=gmail`). */
export function wantsGmail(params: Readonly<Record<string, string | string[] | undefined>>) {
  const raw = params[INBOX_OPEN_PARAM];
  return (Array.isArray(raw) ? raw[0] : raw) === 'gmail';
}

/**
 * A Gmail link to one thread or message, read back into its id and the
 * mailbox it names (`authuser`). Null for anything else: another site, a
 * search or a label, and Gmail's newer opaque ids from the address bar,
 * which the Gmail API (and so Copilot) cannot open. Used where a link was
 * built earlier and only its URL is at hand.
 */
export function parseGmailThreadUrl(
  href: string | null | undefined,
): { id: string; mailbox: string | null } | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return null;
  const segments = url.hash.replace(/^#/, '').split('/');
  // `#all/<id>`, `#inbox/<id>`, `#label/<name>/<id>`, `#search/<q>/<id>`; a bare search is not one email.
  if (segments.length < 2 || (segments[0] === 'search' && segments.length < 3)) return null;
  const id = segments.at(-1) ?? '';
  if (!isGmailId(id)) return null;
  const authuser = url.searchParams.get('authuser');
  return { id: id.toLowerCase(), mailbox: authuser && authuser.includes('@') ? authuser : null };
}
