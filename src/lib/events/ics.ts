/**
 * Calendar files for events (D-075): RFC 5545, METHOD:PUBLISH.
 *
 *   - Public ICS (/e/<slug>/calendar.ics): every session the public can see.
 *   - Personal ICS (/e/<slug>/i/<token>/calendar.ics): only the guest's own
 *     sessions, with their personal link in DESCRIPTION and URL (so the
 *     guest never depends on an automatic email to find it again).
 *
 * Stable UIDs, one per session (and per guest for a personal file),
 * @copilot.tiptop.vc, so re-importing updates rather than duplicates; and
 * SEQUENCE = the event's schedule_version, which bumps on any time or venue
 * change, so calendars accept the update. Times are UTC (…Z). Lines end in
 * CRLF and fold at 75 octets without splitting a UTF-8 character.
 *
 * Pure: no clock (pass `now`), no I/O.
 */

export const ICS_UID_DOMAIN = 'copilot.tiptop.vc';

export interface IcsSession {
  id: string;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  /** Already filtered by the reveal rule: null when the viewer may not see it. */
  location: string | null;
}

export interface IcsInput {
  eventTitle: string;
  sessions: readonly IcsSession[];
  /** schedule_version: the SEQUENCE. */
  sequence: number;
  /** The page or personal link (absolute), for DESCRIPTION and URL. */
  url: string;
  /** Set for a personal file: makes each UID per guest. */
  guestId?: string | null;
  cancelled?: boolean;
  now: Date;
  /** A line prepended to DESCRIPTION (e.g. "Your RSVP and ticket:"). */
  urlLabel?: string;
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** UTC form: 20270125T190000Z. */
export function icsUtc(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

const encoder = new TextEncoder();

/** Fold one content line at 75 octets (continuations start with a space). */
export function foldIcsLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      // Continuation lines carry a leading space, which counts.
      limit = 74;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, '');
}

/** The UID of one session (per guest for a personal file). */
export function icsUid(sessionId: string, guestId?: string | null): string {
  return `${safeIdPart(sessionId)}${guestId ? `.${safeIdPart(guestId)}` : ''}@${ICS_UID_DOMAIN}`;
}

/** Build the calendar. Sessions without a start time are left out. */
export function buildIcs(input: IcsInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TipTop//Copilot Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(input.eventTitle)}`,
  ];
  const timed = input.sessions.filter((s) => !Number.isNaN(Date.parse(s.startsAt)));
  const several = timed.length > 1;
  const stamp = icsUtc(input.now);
  for (const s of timed) {
    const start = new Date(s.startsAt);
    const endParsed = s.endsAt ? Date.parse(s.endsAt) : NaN;
    const end =
      Number.isNaN(endParsed) || endParsed <= start.getTime()
        ? new Date(start.getTime() + 60 * 60 * 1000)
        : new Date(endParsed);
    const summary = several ? `${input.eventTitle} – ${s.name}` : input.eventTitle;
    const description = [
      s.description?.trim() ?? '',
      `${input.urlLabel ?? 'Event page:'} ${input.url}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsUid(s.id, input.guestId)}`,
      `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(start)}`,
      `DTEND:${icsUtc(end)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      `URL:${input.url.replace(/[\r\n]/g, '')}`,
    );
    if (s.location) lines.push(`LOCATION:${escapeIcsText(s.location)}`);
    lines.push(
      `STATUS:${input.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** A filename for the download: "harborview-annual-meeting.ics". */
export function icsFilename(slug: string): string {
  return `${slug.replace(/[^a-z0-9-]/g, '') || 'event'}.ics`;
}
