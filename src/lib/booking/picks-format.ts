import { mergeRanges, type PickRange } from './picks';
import { zoneName } from './public';

/**
 * The words "Copy times and link" puts on the clipboard: one line per day in
 * the other person's zone, the zone's name, and the booking link. Pure: the
 * pick panel previews it and the server returns the same text it made.
 *
 *   Tue, Nov 3: 10:00 – 11:00 AM, 2:00 – 2:30 PM
 *   Wed, Nov 4: 9:00 – 9:30 AM
 *   (Central Time)
 *
 *   Book one here: https://.../meet/nick/p/<token>
 */

interface Clock {
  day: string;
  label: string;
  time: string;
  meridiem: string;
}

function clockIn(ms: number, zone: string): Clock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const month = get('month') ?? '';
  const day = get('day') ?? '';
  return {
    day: `${get('year')}-${month}-${day}`,
    label: `${get('weekday')}, ${month} ${day}`,
    time: `${get('hour')}:${get('minute')}`,
    meridiem: (get('dayPeriod') ?? '').toUpperCase(),
  };
}

/** "10:00 – 11:00 AM", or "11:30 AM – 12:30 PM" across noon. */
export function rangeLabel(start: string, end: string, zone: string): string {
  const a = clockIn(Date.parse(start), zone);
  const b = clockIn(Date.parse(end), zone);
  return a.meridiem === b.meridiem && a.day === b.day
    ? `${a.time} – ${b.time} ${b.meridiem}`
    : `${a.time} ${a.meridiem} – ${b.time} ${b.meridiem}`;
}

/**
 * The zone's short human name: "Central Time", "Japan Time", "UTC". Falls
 * back to the longer label (with its city) when the short one would only be
 * an offset like "GMT+05:45".
 */
export function zoneShortName(zone: string, at: Date = new Date()): string {
  if (/^(utc|etc\/utc|etc\/gmt|gmt)$/i.test(zone)) return 'UTC';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (part && !/^GMT/i.test(part)) return part;
  } catch {
    return zone;
  }
  return zoneName(zone, at);
}

/** The picked ranges as day lines in a zone, days in order: ["Tue, Nov 3: 10:00 – 11:00 AM", ...]. */
export function pickDayLines(ranges: readonly PickRange[], zone: string): string[] {
  const days: { key: string; label: string; parts: string[] }[] = [];
  for (const range of mergeRanges(ranges)) {
    const start = clockIn(Date.parse(range.start), zone);
    const last = days[days.length - 1];
    const part = rangeLabel(range.start, range.end, zone);
    if (last && last.key === start.day) last.parts.push(part);
    else days.push({ key: start.day, label: start.label, parts: [part] });
  }
  return days.map((d) => `${d.label}: ${d.parts.join(', ')}`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The clipboard's plain text and HTML for a pick. `url` is absolute (the
 * server's APP_URL); with no url yet (the panel's preview before Copy) a
 * placeholder stands in.
 */
export function formatPickText(input: {
  ranges: readonly PickRange[];
  timeZone: string;
  url: string | null;
}): { text: string; html: string } {
  const first = input.ranges.length ? Date.parse(mergeRanges(input.ranges)[0]?.start ?? '') : NaN;
  const at = Number.isFinite(first) ? new Date(first) : new Date();
  const lines = pickDayLines(input.ranges, input.timeZone);
  const zoneLine = `(${zoneShortName(input.timeZone, at)})`;
  const link = input.url ?? 'the link';
  const text = [...lines, zoneLine, '', `Book one here: ${link}`].join('\n');
  const anchor = input.url
    ? `<a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a>`
    : escapeHtml(link);
  const html = `<div>${[...lines, zoneLine].map(escapeHtml).join('<br>')}<br><br>Book one here: ${anchor}</div>`;
  return { text, html };
}
