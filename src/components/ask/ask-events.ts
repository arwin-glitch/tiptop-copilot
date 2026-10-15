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
