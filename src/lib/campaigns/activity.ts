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

/* Bounces. */

/**
 * A delivery report's own fields naming who could not be reached: RFC 3464's
 * Final-Recipient and Original-Recipient (`rfc822; jane@acme.example`), and
 * the X-Failed-Recipients line some servers add.
 */
const DSN_RECIPIENT_LINE =
  /^[ \t>]*(?:final-recipient|original-recipient|x-failed-recipients)[ \t]*:(.*)$/gim;

/** Where a bounce starts quoting the message it returns (Gmail, Exim, Postfix, Exchange). */
const QUOTED_ORIGINAL =
  /^[ \t>]*(?:-{2,}[ \t]*(?:original message|forwarded message|below this line is a copy of the message|this is a copy of the message)|original message headers[ \t]*:)/im;

/**
 * A header line of the returned message (To:, Cc: and the rest). It names
 * that message's addressees, the recipient among them, whichever address
 * actually bounced, so it says nothing about who bounced.
 */
const HEADER_LINE =
  /^[ \t>]*(?:to|cc|bcc|from|reply-to|sender|delivered-to|return-path|received|subject|date|message-id|dkim-signature|arc-[\w-]+|x-[\w-]+)[ \t]*:.*$/gim;

/** What may stand just before an address: anything an address cannot contain. */
const BEFORE_ADDRESS = /[\s<>()[\]\\,;:"'`]/;
/** What would carry an address on past its end: more of its domain. */
const MORE_DOMAIN = /^\.?[a-z0-9-]/;

/** Gmail's snippet escapes HTML: `&lt;jane@acme.example&gt;`. */
const unescape = (text: string) =>
  text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&');

/** The exact address in the text, standing alone: not part of a longer one (ana@ in diana@). */
function mentions(text: string, email: string): boolean {
  const hay = text.toLowerCase();
  for (let at = hay.indexOf(email); at >= 0; at = hay.indexOf(email, at + 1)) {
    const before = at > 0 ? (hay[at - 1] as string) : ' ';
    if (!BEFORE_ADDRESS.test(before)) continue;
    if (MORE_DOMAIN.test(hay.slice(at + email.length, at + email.length + 2))) continue;
    return true;
  }
  return false;
}

/**
 * Whether a bounce names this exact address (any case) as one that could not
 * be reached. A delivery report's own fields decide when it has them, since
 * they are exact. Otherwise the bounce's own words do, up to where it starts
 * quoting the returned message, leaving out header lines. Reads the snippet
 * and, once fetched, the body. A bounce that names nobody it can be sure of
 * names nobody.
 */
export function bounceNames(
  message: { snippet: string | null; body_text: string | null },
  email: string,
): boolean {
  const target = email.trim().toLowerCase();
  if (!target.includes('@')) return false;
  const texts = [message.snippet ?? '', message.body_text ?? ''].map(unescape);
  const fields = texts.flatMap((text) =>
    [...text.matchAll(DSN_RECIPIENT_LINE)].map((line) => line[1] ?? ''),
  );
  if (fields.length) return fields.some((field) => mentions(field, target));
  return texts.some((text) => {
    const cut = text.search(QUOTED_ORIGINAL);
    return mentions((cut >= 0 ? text.slice(0, cut) : text).replace(HEADER_LINE, ''), target);
  });
}
