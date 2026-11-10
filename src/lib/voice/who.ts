/** Picking the person Voice Arwin means, and their email to reply to (/api/voice/who). */

const CALENDAR_NOTICE =
  /^(?:accepted|declined|tentatively accepted|invitation|updated invitation|canceled event|cancelled event|new event)(?=\W|$)/i;

export function isCalendarNotice(subject: string): boolean {
  return CALENDAR_NOTICE.test(subject.trim());
}

/**
 * The one person a spoken name means, or null when two fit about equally.
 * A full name said ("Pat Ponseti") wins over people who only share a first
 * name; otherwise the clearly most-contacted one wins.
 */
export function pickPerson<
  T extends { name: string | null; email: string; threads: number; meetings: number },
>(said: string, hits: readonly T[]): T | null {
  const words = said.toLowerCase().split(/\s+/).filter(Boolean);
  const holdsAll = (h: T) => {
    const hay = `${h.name ?? ''} ${h.email}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const full = words.length > 1 ? hits.filter(holdsAll) : [];
  const pool = full.length ? full : [...hits];
  const [top, next] = pool;
  if (!top) return null;
  if (next && next.threads + next.meetings >= (top.threads + top.meetings) * 0.6) return null;
  return top;
}
