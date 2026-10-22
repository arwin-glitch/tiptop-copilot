/**
 * Guest-facing date and time text for event pages (D-075): always in the
 * venue's time zone, with the zone named, and a "your time" line when the
 * viewer's zone differs (computed in the browser after load, so the server
 * render never guesses a viewer's zone). Pure.
 */

function parts(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(iso));
  }
}

function zoneName(iso: string, timeZone: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(
      new Date(iso),
    );
    return p.find((x) => x.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    return 'UTC';
  }
}

function sameDay(a: string, b: string, timeZone: string): boolean {
  const d = (iso: string) =>
    parts(iso, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return d(a) === d(b);
}

/** "Mon, Jan 25" */
export function formatDay(iso: string, timeZone: string): string {
  return parts(iso, timeZone, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Monday, January 25, 2027" */
export function formatLongDay(iso: string, timeZone: string): string {
  return parts(iso, timeZone, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** "1:00 PM" */
export function formatClock(iso: string, timeZone: string): string {
  return parts(iso, timeZone, { hour: 'numeric', minute: '2-digit' });
}

/**
 * "Mon, Jan 25 · 1:00 – 5:00 PM CST", or across days
 * "Mon, Jan 25, 6:00 PM – Tue, Jan 26, 1:00 AM CST". Empty for no start.
 */
export function formatRange(
  startsAt: string | null,
  endsAt: string | null,
  timeZone: string,
): string {
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) return '';
  const zone = zoneName(startsAt, timeZone);
  const start = formatClock(startsAt, timeZone);
  if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
    return `${formatDay(startsAt, timeZone)} · ${start} ${zone}`;
  }
  const end = formatClock(endsAt, timeZone);
  if (sameDay(startsAt, endsAt, timeZone)) {
    return `${formatDay(startsAt, timeZone)} · ${start} – ${end} ${zone}`;
  }
  return `${formatDay(startsAt, timeZone)}, ${start} – ${formatDay(endsAt, timeZone)}, ${end} ${zone}`;
}

/** Whether the viewer's zone shows a different wall clock than the venue's for this instant. */
export function differsFromViewer(iso: string, venueZone: string, viewerZone: string): boolean {
  if (!viewerZone || viewerZone === venueZone) return false;
  return (
    formatClock(iso, venueZone) !== formatClock(iso, viewerZone) || !sameDay(iso, iso, viewerZone)
  );
}

/** A check-in time: "6:42 PM". */
export function formatCheckinTime(iso: string | null, timeZone: string): string {
  return iso ? formatClock(iso, timeZone) : '';
}
