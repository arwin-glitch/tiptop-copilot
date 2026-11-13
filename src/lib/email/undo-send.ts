/**
 * Gmail's "Undo Send" cancellation period: how long Send waits, with Undo
 * showing, before the email goes. Gmail offers 5, 10, 20 or 30 seconds;
 * the choice is remembered per browser (no settings table). Before this
 * setting Kraken waited 8 seconds. Nov 13: the default is 5, the box goes
 * at once and Undo waits in a toast (Gmail's own default).
 */
export const UNDO_SEND_CHOICES = ['5', '10', '20', '30'] as const;
export type UndoSendChoice = (typeof UNDO_SEND_CHOICES)[number];

export const UNDO_SEND_KEY = 'kraken.inbox.undoSend';
export const UNDO_SEND_DEFAULT: UndoSendChoice = '5';

export function parseUndoSend(value: string | null | undefined): UndoSendChoice {
  return (UNDO_SEND_CHOICES as readonly string[]).includes(value ?? '')
    ? (value as UndoSendChoice)
    : UNDO_SEND_DEFAULT;
}

export function undoSeconds(choice: UndoSendChoice): number {
  return Number(choice);
}
