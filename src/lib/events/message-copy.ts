import type { NotifyKind } from '@/lib/events/contracts';
import type { EventCampaignKind } from '@/lib/types/domain';
import { NOTIFY_LABELS, offsetLabel } from '@/lib/events/tab-view';

/**
 * The starting subject and body of each event message (D-075). Every one is a
 * campaign DRAFT: a person reads it, edits it and taps Send in the campaign
 * review. The copy is plain, warm and short, in the event's own words (its
 * title, its dates, its venue), ends at the sign-off (the sender's signature
 * is added when it goes) and always carries the guest's personal link as
 * {{rsvp_link}}, which the server fills per recipient.
 *
 * Pure, so the tests read exactly what a draft starts as.
 */

export interface MessageContext {
  title: string;
  /** "Sat, Jan 25, 2027 · 1:00 PM – 9:00 PM CST". */
  when: string;
  venueName: string | null;
  sessions: { name: string; when: string }[];
  cancelMessage: string | null;
}

export interface MessageOptions {
  notifyKind?: NotifyKind;
  /** Reminder: which session, and how long before. */
  session?: { name: string; when: string } | null;
  offsetMinutes?: number;
  segment?: 'opened_no_reply' | 'never_opened';
}

export interface MessageCopy {
  /** The campaign's name in Copilot; guests never see it. */
  name: string;
  subject: string;
  body: string;
}

/**
 * Host-written text (a title, a venue, a cancel note) made safe to drop into
 * a template: one line, and no {{ }} that the grammar would read as a merge
 * tag (an unknown tag would block the review). The grammar has no escape
 * character, so *, [ and ] are left alone; at worst they format.
 */
export function literal(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .trim();
}

/** "at The Lantern Hall", or nothing. */
function at(venue: string | null): string {
  return venue ? ` at ${literal(venue)}` : '';
}

/** A short "when" for a reminder subject: "next week", "tomorrow", "in 3 hours". */
function soon(offsetMinutes: number | undefined): string {
  if (!offsetMinutes) return 'coming up';
  if (offsetMinutes >= 10_080) return offsetMinutes === 10_080 ? 'next week' : 'coming up';
  if (offsetMinutes >= 1_440) return offsetMinutes === 1_440 ? 'tomorrow' : 'in a few days';
  return 'today';
}

const NOTICE: Record<
  NotifyKind,
  { subject: (t: string) => string; body: (c: MessageContext) => string }
> = {
  confirmed: {
    subject: (t) => `You're confirmed for ${t}`,
    body: (c) =>
      `Good news: your spot at ${literal(c.title)} is confirmed. We look forward to seeing you on ${c.when}${at(c.venueName)}.\n\nYour details, your ticket and a calendar file are here: {{rsvp_link|your RSVP}}`,
  },
  waitlisted: {
    subject: (t) => `You're on the waitlist for ${t}`,
    body: (c) =>
      `Thank you for your interest in ${literal(c.title)}. We're full right now, so you're on the waitlist, and we'll let you know as soon as a spot opens.\n\nYou can check or change your answer here: {{rsvp_link|your RSVP}}`,
  },
  promoted: {
    subject: (t) => `A spot opened for ${t}`,
    body: (c) =>
      `Good news: a spot opened up for ${literal(c.title)} on ${c.when}, and it's yours.\n\nPlease confirm you can still make it: {{rsvp_link|confirm your spot}}`,
  },
  declined: {
    subject: (t) => `About ${t}`,
    body: (c) =>
      `Thank you for your interest in ${literal(c.title)}. Unfortunately we can't offer you a spot this time.\n\nWe hope to see you at a future event.`,
  },
  pending: {
    subject: (t) => `We got your request for ${t}`,
    body: (c) =>
      `Thanks for registering for ${literal(c.title)}. We'll confirm your spot shortly.\n\nYour request: {{rsvp_link|your RSVP}}`,
  },
};

const GREETING = 'Hi {{first_name|there}},';

/** A draft's starting copy, by kind. */
export function messageCopy(
  kind: EventCampaignKind,
  context: MessageContext,
  options: MessageOptions = {},
): MessageCopy {
  const title = literal(context.title);
  const t = title;
  const sessionLines =
    context.sessions.length > 1
      ? `\n\n${context.sessions.map((s) => `- ${literal(s.name)}: ${s.when}`).join('\n')}`
      : '';
  switch (kind) {
    case 'invite':
      return {
        name: `${title} · Invite`,
        subject: `You're invited: ${title}`,
        body: `${GREETING}\n\nWe would love for you to join us for ${t} on ${context.when}${at(context.venueName)}.${sessionLines}\n\nYour personal invitation, with the details and your RSVP: {{rsvp_link|RSVP here}}\n\nHope to see you there.`,
      };
    case 'reminder': {
      const session = options.session ?? { name: title, when: context.when };
      const label = options.offsetMinutes ? offsetLabel(options.offsetMinutes) : 'before';
      return {
        name: `${title} · Reminder (${label}, ${session.name})`,
        subject: `Reminder: ${session.name === title ? title : `${title}, ${session.name}`} is ${soon(options.offsetMinutes)}`,
        body: `${GREETING}\n\nA quick reminder that ${literal(session.name)} is on ${session.when}${at(context.venueName)}.\n\nYour details, ticket and calendar file: {{rsvp_link|your RSVP}}\n\nSee you soon.`,
      };
    }
    case 'notice': {
      const notifyKind = options.notifyKind ?? 'confirmed';
      const notice = NOTICE[notifyKind];
      // About one session: its name and its time, not the whole event's.
      const s = options.session;
      const about = s
        ? { ...context, title: `${context.title}: ${s.name}`, when: s.when }
        : context;
      return {
        name: `${title} · Notice: ${NOTIFY_LABELS[notifyKind].title}${s ? ` (${literal(s.name)})` : ''}`,
        subject: notice.subject(literal(about.title)),
        body: `${GREETING}\n\n${notice.body(about)}`,
      };
    }
    case 'update':
      return {
        name: `${title} · Update`,
        subject: `Update: ${title}`,
        body: `${GREETING}\n\nA quick update on ${t}: it is now on ${context.when}${at(context.venueName)}.${sessionLines}\n\nYour details and an updated calendar file are here: {{rsvp_link|your RSVP}}\n\nSee you there.`,
      };
    case 'cancellation': {
      const note = context.cancelMessage?.trim() ? `\n\n${literal(context.cancelMessage)}` : '';
      return {
        name: `${title} · Cancellation`,
        subject: `${title} is cancelled`,
        body: `${GREETING}\n\nUnfortunately we have had to cancel ${t}, planned for ${context.when}.${note}\n\nWe are sorry for the change, and we hope to see you soon.`,
      };
    }
    case 'nudge':
      return {
        name: `${title} · Nudge (${options.segment === 'never_opened' ? 'never opened' : 'opened, no reply'})`,
        subject: `Did you see the invite to ${title}?`,
        body: `${GREETING}\n\nJust making sure my note about ${t} on ${context.when} did not get buried.\n\nYour personal invitation: {{rsvp_link|RSVP here}}\n\nHope you can make it.`,
      };
    case 'blast':
      return {
        name: `${title} · Message`,
        subject: title,
        body: `${GREETING}\n\n[Write your message here.]\n\nYour details: {{rsvp_link|your RSVP}}`,
      };
  }
}
