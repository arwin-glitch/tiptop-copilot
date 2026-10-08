/**
 * Signatures the email session can put under a reply sent from Nick's inbox.
 *
 * "nick" is Nick's own Gmail signature, read live from his mailbox settings.
 * "arwin" is for when Arwin replies as himself from Nick's inbox.
 */
export type SignatureChoice = 'nick' | 'arwin';

export const ARWIN_SIGNATURE_HTML =
  '<div>Arwin Reyes</div><div>Executive Assistant, TipTop Ventures</div>';

/** The sign-off name that goes with each signature, used to swap "Nick" for "Arwin". */
export const SIGN_OFF_NAME: Record<SignatureChoice, string> = { nick: 'Nick', arwin: 'Arwin' };
