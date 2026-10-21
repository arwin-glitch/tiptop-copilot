import { gmailThreadUrl } from '@/lib/deals/links';

/**
 * Where an email link goes. Every email or thread link in the app offers two
 * places to read it: "Copilot", the Inbox's reading pane at
 * `/inbox?thread=<id>`, and "Gmail", the thread in Gmail in the browser. Both
 * are rebuilt from a validated Gmail id, never from a stored URL. The id may
 * be a thread's or a message's: Gmail opens either, and the Inbox resolves a
 * message id to its thread on the server.
 *
 * Pure and client-safe; the two links themselves are
 * `src/components/email/thread-links.tsx`.
 */

const GMAIL_ID = /^[0-9a-f]{10,24}$/i;

/** The Inbox's URL parameter for one conversation to open. */
export const INBOX_THREAD_PARAM = 'thread';

/** Whether a value is a Gmail thread or message id (hex). */
export function isGmailId(id: unknown): id is string {
  return typeof id === 'string' && GMAIL_ID.test(id);
}

/** The conversation in Copilot's Inbox, or null for anything that is not a Gmail id. */
export function copilotThreadHref(id: string | null | undefined): string | null {
  return isGmailId(id) ? `/inbox?${INBOX_THREAD_PARAM}=${id.toLowerCase()}` : null;
}

/** Both places to read one email: null when the id is not a Gmail id. */
export function threadLinks(
  id: string | null | undefined,
  mailbox: string | null | undefined,
): { copilot: string; gmail: string } | null {
  const copilot = copilotThreadHref(id);
  const gmail = id ? gmailThreadUrl(id, mailbox) : null;
  return copilot && gmail ? { copilot, gmail } : null;
}

/**
 * The id an Inbox URL asks to open: `?thread=<id>`. Null when the URL asks
 * for none; anything that is not a Gmail id comes back as given, so the page
 * can say it could not open it rather than ignore the link.
 */
export function inboxThreadParam(
  params: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const raw = params[INBOX_THREAD_PARAM];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return null;
  return GMAIL_ID.test(value) ? value.toLowerCase() : value.slice(0, 100);
}
