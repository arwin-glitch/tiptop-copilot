/**
 * Page shortcuts (the live Inbox's Gmail keys, the email session's
 * Ctrl+Enter send) listen on `window`. Whatever is drawn over a page (the Ask
 * Arwin panel, a guided tour's card, any dialog) owns the keyboard while it is
 * up: a key pressed inside one, or anywhere while a modal one is open, must
 * never act on the page underneath, such as archiving a thread, opening one
 * and marking it read, or sending an email.
 */

/** Anything drawn over the page that has keys of its own. */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-tour-card], [data-ask-panel]';

/** An overlay that leaves the page inert while it is open. */
const MODAL_SELECTOR =
  '[data-ask-panel], [role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"]';

/**
 * True when a page shortcut should stand down for this key: something already
 * handled it (the Ask composer's Enter, a dialog's Esc), it was pressed inside
 * an overlay (even one that has just closed and left the page), or a modal one
 * is open.
 */
export function keyBelongsToOverlay(
  event: Pick<KeyboardEvent, 'target' | 'defaultPrevented'>,
): boolean {
  if (event.defaultPrevented) return true;
  try {
    const target = event.target;
    if (target instanceof Element && target.closest(OVERLAY_SELECTOR)) return true;
    return document.querySelector(MODAL_SELECTOR) !== null;
  } catch {
    // When in doubt, a shortcut that does nothing is the safe failure.
    return true;
  }
}
