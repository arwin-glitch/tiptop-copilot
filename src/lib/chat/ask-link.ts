/**
 * Links into Ask, read the way the Ask Arwin widget reads them.
 *
 * The app still links to `/ask` (with `?q=`, `?deal=` or `?thread=`) so every
 * link keeps working as a full page without script. Once the widget is on the
 * page it catches those clicks and opens itself instead; this decides which
 * clicks it may take and what they ask for.
 */

export interface AskRequest {
  /** Asked straight away when Ask is available, otherwise left in the box. */
  question?: string;
  /** Scopes a new conversation to one deal. */
  dealId?: string;
  /** Opens an existing conversation. */
  threadId?: string;
}

/** The query parameter any page can carry to open the widget: `?ask=<question>`. */
export const ASK_QUERY_PARAM = 'ask';

/** The widget's own full-page links carry this attribute and are never caught. */
export const ASK_FULL_PAGE_ATTR = 'data-ask-full-page';

const MAX_QUESTION = 4_000;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The request an `/ask` link makes, or null when `href` is not a same-origin
 * link to the Ask page. `base` is the page the link sits on.
 */
export function askRequestFromHref(href: string, base: string): AskRequest | null {
  let url: URL;
  let origin: string;
  try {
    url = new URL(href, base);
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname !== '/ask' && url.pathname !== '/ask/') return null;
  // Another section of the full page (`?tab=feedback`) is a page to open,
  // not a question for the widget.
  const tab = url.searchParams.get('tab');
  if (tab !== null && tab !== 'conversations') return null;

  const request: AskRequest = {};
  const question = url.searchParams.get('q')?.trim();
  if (question) request.question = question.slice(0, MAX_QUESTION);
  const dealId = url.searchParams.get('deal')?.trim();
  if (dealId && ID_PATTERN.test(dealId)) request.dealId = dealId;
  const threadId = url.searchParams.get('thread')?.trim();
  if (threadId && ID_PATTERN.test(threadId)) request.threadId = threadId;
  return request;
}

/** The request a page's `?ask=` parameter makes; an empty value just opens the widget. */
export function askRequestFromParam(value: string | null): AskRequest | null {
  if (value === null) return null;
  const question = value.trim().slice(0, MAX_QUESTION);
  return question ? { question } : {};
}
