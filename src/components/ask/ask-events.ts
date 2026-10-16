import type { AskRequest } from '@/lib/chat/ask-link';

/**
 * Open the Ask Arwin widget from anywhere in the client: a button that wants
 * to ask about what is on screen calls `openAskWidget({ question })`. Links
 * need nothing: a plain `/ask?q=…` link is caught by the widget itself and
 * still works as a full page without script.
 */
export const ASK_OPEN_EVENT = 'tiptop:ask-open';

export function openAskWidget(request: AskRequest = {}): void {
  window.dispatchEvent(new CustomEvent<AskRequest>(ASK_OPEN_EVENT, { detail: request }));
}

/**
 * Sent whenever the Ask Arwin panel opens or closes, with `{ open }`. The
 * guided tour waits while the panel is open: the panel is modal, and a tour
 * card over it would only get in its way.
 */
export const ASK_PANEL_EVENT = 'tiptop:ask-panel';

export interface AskPanelDetail {
  open: boolean;
}

/**
 * The full Ask page tells the widget about a question it is waiting on, with
 * `{ threadId, watching: true }`, and that it is done waiting (the answer
 * landed on screen there) with `watching: false`. The widget keeps
 * checking after Nick leaves the page, so an answer that lands later still
 * gets its "Arwin replied" pop-up wherever he is.
 */
export const ASK_WATCH_EVENT = 'tiptop:ask-watch';

export interface AskWatchDetail {
  threadId: string;
  watching: boolean;
}

export function watchAskReply(detail: AskWatchDetail): void {
  window.dispatchEvent(new CustomEvent<AskWatchDetail>(ASK_WATCH_EVENT, { detail }));
}
