/**
 * Signatures the email session can put under a reply sent from Nick's inbox.
 *
 * "nick" is Nick's own Gmail signature ("v1"), read live from his mailbox
 * settings at send time: Google exposes the default signature only, and v1 is
 * Nick's default for new emails. If it cannot be read, the session refuses to
 * send as Nick rather than send unsigned.
 *
 * "arwin" is for when Arwin replies as himself from Nick's inbox. Google does
 * not expose a mailbox's other named signatures to apps, so this is a copy of
 * the "Arwin" signature saved in Nick's Gmail, taken from his settings on
 * 2026-10-08 with its links and logo. If Arwin edits it in Gmail, update it
 * here too.
 */
export type SignatureChoice = 'nick' | 'arwin';

export const ARWIN_SIGNATURE_HTML =
  'Arwin Reyes<br>Executive Assistant to Nick Tippmann<br>' +
  '<a href="http://tiptop.vc/" target="_blank">TipTop VC</a><br>' +
  '<a href="https://www.linkedin.com/in/arwin-angelo-reyes-36699b228/" target="_blank">LinkedIn</a><br>' +
  '<div>(864) 712-4199</div>' +
  '<div><img src="https://ci3.googleusercontent.com/mail-sig/AIorK4wNTs72NiXAoqiV3e88GGVGsBc2eIMJlQ0-R9kn0XZ-C4r06tkEBtqY3CZ8E2bkJfuzpTB8veg" width="96" height="31"></div>';

/** The sign-off name that goes with each signature, used to swap "Nick" for "Arwin". */
export const SIGN_OFF_NAME: Record<SignatureChoice, string> = { nick: 'Nick', arwin: 'Arwin' };
