/**
 * Signatures the email session can put under a reply sent from Nick's inbox.
 *
 * "nick" is Nick's own Gmail signature ("v1"), read live from his mailbox
 * settings at send time: Google exposes the default signature only, and v1 is
 * Nick's default for new emails. If it cannot be read, the session refuses to
 * send as Nick rather than send unsigned.
 *
 * "arwin" is for when Arwin replies as himself from Nick's inbox. Google does
 * not expose a mailbox's other named signatures to apps, so it is kept here.
 * Nov 12: redesigned as a proper card (logo, a dividing line, name, title and
 * contact row), built from tables and inline styles only so it holds in
 * Gmail, Outlook and Apple Mail. The logo is the one in Nick's Gmail.
 */
export type SignatureChoice = 'nick' | 'arwin';

export const ARWIN_SIGNATURE_HTML =
  '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#1f2328"><tr>' +
  '<td style="padding:2px 14px 2px 0;border-right:2px solid #1d6b55;vertical-align:middle">' +
  '<a href="http://tiptop.vc/" target="_blank"><img src="https://ci3.googleusercontent.com/mail-sig/AIorK4wNTs72NiXAoqiV3e88GGVGsBc2eIMJlQ0-R9kn0XZ-C4r06tkEBtqY3CZ8E2bkJfuzpTB8veg" width="96" height="31" alt="TipTop VC" style="display:block;border:0"></a></td>' +
  '<td style="padding:2px 0 2px 14px;vertical-align:middle">' +
  '<div style="font-size:15px;font-weight:bold;color:#1d6b55">Arwin Reyes</div>' +
  '<div style="color:#57606a">Executive Assistant to Nick Tippmann</div>' +
  '<div style="color:#57606a">TipTop VC</div>' +
  '<div style="margin-top:3px">' +
  '<a href="tel:+18647124199" style="color:#1d6b55;text-decoration:none">(864) 712-4199</a>' +
  '<span style="color:#b8c2cc">&nbsp;&nbsp;|&nbsp;&nbsp;</span>' +
  '<a href="https://www.linkedin.com/in/arwin-angelo-reyes-36699b228/" target="_blank" style="color:#1d6b55;text-decoration:none">LinkedIn</a>' +
  '<span style="color:#b8c2cc">&nbsp;&nbsp;|&nbsp;&nbsp;</span>' +
  '<a href="http://tiptop.vc/" target="_blank" style="color:#1d6b55;text-decoration:none">tiptop.vc</a>' +
  '</div></td></tr></table>';

/** The sign-off name that goes with each signature, used to swap "Nick" for "Arwin". */
export const SIGN_OFF_NAME: Record<SignatureChoice, string> = { nick: 'Nick', arwin: 'Arwin' };
