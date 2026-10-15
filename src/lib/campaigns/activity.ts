/**
 * Telling a person's open, click or reply from a machine's. Pure, so the
 * rules are testable on their own and the report can explain them.
 *
 * Opens and clicks are estimates whatever we do: an email client that loads
 * images counts as an open, one that blocks them never does. What can be
 * filtered is the traffic that is plainly not a person reading:
 *
 *   - Link scanners. Corporate mail filters (Microsoft Defender, Mimecast,
 *     Proofpoint, Barracuda...) fetch every link in a message as it arrives,
 *     usually within seconds and all at once. So a click in the first minute
 *     after sending, a click on a second link within a few seconds of the
 *     first, a HEAD request or a prefetch, or a request from a known scanner
 *     or HTTP library is recorded as automated and not counted.
 *   - Automatic replies. An out-of-office in the thread is not a reply.
 *
 * What cannot be filtered: Gmail's image proxy fetches the pixel for every
 * Gmail reader alike, including Nick opening the copy in his own Sent folder.
 * The report says so.
 */

/** Opens and clicks this soon after the email was sent are taken as the recipient's mail filter. */
export const SCAN_WINDOW_MS = 60_000;

/** Two different links clicked this close together are a scanner walking the email. */
export const CLICK_BURST_MS = 3_000;

/**
 * User agents of HTTP libraries and known mail scanners. A browser, a mail
 * app, and Gmail's or Outlook's image proxies are none of these.
 */
const AUTOMATED_AGENT =
  /\b(bot|crawler|spider|slurp|scanner|scan|preview|prefetch|validator|monitor|python|curl|wget|go-http-client|java\/|okhttp|libwww|httpclient|http_request|axios|node-fetch|undici|barracuda|mimecast|proofpoint|forcepoint|symantec|messagelabs|trend ?micro|ironport|cisco|fireeye|sophos|safelinks|zscaler)\b|headless|phantomjs/i;

/** Whether a request's user agent is a machine's (or missing, which no mail app sends). */
export function isAutomatedAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? '').trim();
  if (!ua) return true;
  // Gmail's and Yahoo's image proxies stand in for real readers.
  if (/GoogleImageProxy|YahooMailProxy/i.test(ua)) return false;
  return AUTOMATED_AGENT.test(ua);
}

/** Whether request headers mark it as a speculative prefetch rather than a visit. */
export function isPrefetch(headers: { get(name: string): string | null }): boolean {
  const purpose = `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''} ${headers.get('x-moz') ?? ''} ${headers.get('x-purpose') ?? ''}`;
  return /\b(prefetch|preview|prerender)\b/i.test(purpose);
}

/** Whether something that happened at `at` came too soon after `sentAt` to be the person. */
export function withinScanWindow(
  sentAt: string | null | undefined,
  at: Date,
  windowMs: number = SCAN_WINDOW_MS,
): boolean {
  if (!sentAt) return false;
  const sent = Date.parse(sentAt);
  return Number.isFinite(sent) && at.getTime() - sent < windowMs;
}

/** Subjects mail servers give automatic replies, in the languages LPs are likeliest to use. */
const AUTO_REPLY_SUBJECT =
  /^\s*(?:(?:re|aw|sv|fw|fwd)\s*:\s*)*(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response|antwort)|autoreply|autosvar|out of (?:the )?office|ooo\b|away from (?:the )?office|on (?:vacation|holiday|leave)|abwesenheit|abwesenheitsnotiz|r[ée]ponse automatique|absence du bureau|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|fuori ufficio|resposta autom[áa]tica|automatisch antwoord|afwezig|automatiskt svar|automatisk svar|frånvaro)/i;

/** Phrases an out-of-office opens with, for responders that keep "Re: <subject>". */
const AUTO_REPLY_TEXT =
  /\b(?:i am|i'm|i’m) (?:currently )?(?:out of (?:the )?office|away|on (?:annual |parental |maternity |paternity )?(?:leave|vacation|holiday))|\bout of (?:the )?office (?:until|from|through|and)|\bwith limited (?:access to (?:e-?mail|my inbox)|connectivity)|\bthis is an auto(?:matic|mated)[- ](?:reply|response)|\bauto(?:matic|mated)? reply\b|\bi will (?:be )?(?:back|return(?:ing)?) (?:on|to the office)/i;

/** An automatic reply arrives within minutes; text that merely sounds like one later is a person. */
const AUTO_REPLY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Whether a message in a sent email's thread is an automatic reply (out of
 * office, vacation responder) rather than the person answering. The subject
 * is decisive; the opening text counts only when it came within half an
 * hour of the send, because a real reply can say "I'm out of office this week
 * but...".
 */
export function isAutoReply(
  message: { subject: string | null; snippet: string | null; sent_at: string },
  sentAt: string | null | undefined,
): boolean {
  if (AUTO_REPLY_SUBJECT.test(message.subject ?? '')) return true;
  if (!AUTO_REPLY_TEXT.test(message.snippet ?? '')) return false;
  if (!sentAt) return false;
  return Date.parse(message.sent_at) - Date.parse(sentAt) <= AUTO_REPLY_WINDOW_MS;
}
