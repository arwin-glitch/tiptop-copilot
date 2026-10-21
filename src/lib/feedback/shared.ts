/**
 * In-app feedback, the parts both sides use: what someone wants changed in
 * Copilot, sent from the Feedback tab of the Ask Arwin panel with the page it
 * was sent from, and read and closed on the full Ask page's Feedback tab.
 *
 * Pure, and free of `server-only`, so the widget that sends a note, the list
 * that shows them and the service that stores them agree on one shape, one
 * set of limits and one rule for what counts as a page.
 */

/** Where the list lives: the full Ask page's Feedback tab. */
export const FEEDBACK_HREF = '/ask?tab=feedback';

/** Long enough for a dictated paragraph or two; the box stops there. */
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_PATH_MAX = 500;
export const FEEDBACK_TITLE_MAX = 200;

export type FeedbackStatus = 'open' | 'done';

export interface FeedbackItem {
  id: string;
  /** Exactly as typed (or dictated), trimmed. */
  text: string;
  /** The in-app page it was sent from (path and query); null when sent from no page. */
  path: string | null;
  /** That page's name as its tab showed it, without the app's suffix. */
  title: string | null;
  /** The sender's first name when it was sent. */
  by: string | null;
  userId: string | null;
  at: string;
  status: FeedbackStatus;
  /** When and by whom it was last marked done or reopened; null if never. */
  changedAt: string | null;
  changedBy: string | null;
}

/**
 * A page a note may name: one leading `/`, never `//` or a backslash (either
 * could reach another site), no spaces, control characters or fragment, and
 * at most FEEDBACK_PATH_MAX characters. Anything else is stored as no page.
 */
const FEEDBACK_PATH = /^\/(?![/\\])[^\s\\#]*$/;

export function isFeedbackPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= FEEDBACK_PATH_MAX &&
    FEEDBACK_PATH.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** "(1) Today · TipTop Copilot" (a reply counted in the tab) reads as "Today". */
export function pageTitleFrom(documentTitle: string): string | null {
  const title = documentTitle
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*·\s*TipTop Copilot$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FEEDBACK_TITLE_MAX);
  return title && title !== 'TipTop Copilot' ? title : null;
}

/**
 * The page a note is about, from the browser's location and title: its path
 * and query (never the fragment or the origin), and its name. A location
 * that is not a plain in-app page is sent as no page.
 */
export function feedbackPageFrom(
  href: string,
  documentTitle: string,
): { path: string | null; title: string | null } {
  let path: string | null = null;
  try {
    const url = new URL(href);
    const candidate = `${url.pathname}${url.search}`;
    path = isFeedbackPath(candidate) ? candidate : null;
  } catch {
    path = null;
  }
  return { path, title: pageTitleFrom(documentTitle) };
}

export function feedbackCounts(items: readonly Pick<FeedbackItem, 'status'>[]): {
  open: number;
  done: number;
} {
  let open = 0;
  for (const item of items) if (item.status === 'open') open += 1;
  return { open, done: items.length - open };
}
