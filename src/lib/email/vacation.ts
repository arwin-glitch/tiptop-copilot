/**
 * Gmail's vacation responder, as Kraken shows and saves it. Turning it on is
 * an auto-reply rule: it answers incoming mail on its own until it ends, so
 * the Inbox saves one only from a person's Save click after a confirm that
 * says so, and shows a banner with Turn off while it is on. Pure and
 * client-safe.
 */

export interface VacationSettings {
  enabled: boolean;
  subject: string;
  /** The message, as sanitized HTML (signature-html.ts). */
  html: string;
  /** Only send a response to people in my Contacts. */
  contactsOnly: boolean;
  /** Only send a response to people in my organization (the mailbox's domain). */
  domainOnly: boolean;
  /** ISO instants; null for "from now" and "until I turn it off". */
  start: string | null;
  end: string | null;
}

export const VACATION_OFF: VacationSettings = {
  enabled: false,
  subject: '',
  html: '',
  contactsOnly: false,
  domainOnly: false,
  start: null,
  end: null,
};

export const MAX_VACATION_SUBJECT = 250;

/** Whether the responder is answering mail right now (on, and inside its dates). */
export function vacationActive(v: VacationSettings | null, now: Date = new Date()): boolean {
  if (!v?.enabled) return false;
  const t = now.getTime();
  if (v.start && new Date(v.start).getTime() > t) return false;
  if (v.end && new Date(v.end).getTime() <= t) return false;
  return true;
}

/** Why these settings cannot be saved as on, or null when they can. */
export function vacationProblem(v: VacationSettings): string | null {
  if (!v.enabled) return null;
  if (!v.subject.trim() && !v.html.replace(/<[^>]*>/g, '').trim()) {
    return 'Write a subject or a message for the auto-reply.';
  }
  if (v.subject.length > MAX_VACATION_SUBJECT) return 'The subject is too long.';
  if (v.start && Number.isNaN(new Date(v.start).getTime())) return 'The first day is not a date.';
  if (v.end && Number.isNaN(new Date(v.end).getTime())) return 'The last day is not a date.';
  if (v.start && v.end && new Date(v.end).getTime() <= new Date(v.start).getTime()) {
    return 'The last day must be after the first day.';
  }
  return null;
}

/** The confirm's words: what turning it on will do, plainly. */
export function vacationConfirmText(v: VacationSettings, mailbox: string | null): string {
  const domain = mailbox?.split('@')[1] ?? 'your organization';
  const who =
    v.contactsOnly && v.domainOnly
      ? `people in your Contacts at ${domain}`
      : v.contactsOnly
        ? 'people in your Contacts'
        : v.domainOnly
          ? `people at ${domain}`
          : 'everyone who emails you';
  const until = v.end ? ` until ${v.end.slice(0, 10)}` : ' until you turn it off';
  const from = v.start ? `From ${v.start.slice(0, 10)}, Gmail` : 'Gmail';
  return `${from} will automatically reply to incoming mail from ${who}${until}, sending your subject and message. Gmail sends it at most once every 4 days to the same person.`;
}
