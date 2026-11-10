/**
 * Voice Arwin doing things, not just opening pages. Pure: no React, no
 * browser. Each command is read back and, when it changes something, waits
 * for a spoken "yes" (voice-arwin.tsx). Email is never sent: a reply or an
 * invite opens in the Inbox filled in, for the person to read and send.
 *
 *  - "snooze this (until Monday | for 3 days | till next week)": the task or
 *    the email thread open on screen.
 *  - "mark this done": the task open on screen.
 *  - "remind me to … (by Friday)", "add a task to …": a new task.
 *  - "reply to Patrick (saying | that | :) Wednesday works": his latest
 *    thread, the reply box filled in.
 *  - "book Nick a coffee with Sarah", "set up a call with Dana": an email to
 *    them with Nick's booking link, opened on that kind of meeting.
 */

export type MealKind = 'coffee' | 'lunch' | 'dinner';

export type VoiceAction =
  | { kind: 'snooze'; target: 'task' | 'thread'; id: string; until: Date; untilLabel: string }
  | { kind: 'done'; taskId: string }
  | { kind: 'new_task'; title: string; dueAt: Date | null; dueLabel: string | null }
  | { kind: 'reply'; who: string; text: string }
  | { kind: 'invite'; who: string; meeting: MealKind | 'call' };

/** Where the person is: what "this" means. */
export interface VoicePlace {
  pathname: string;
  search: string;
}

const TASK_PATH = /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The task or email thread open on screen, if any. */
export function thisOnScreen(place: VoicePlace): { task?: string; thread?: string } {
  const task = TASK_PATH.exec(place.pathname)?.[1];
  if (task) return { task };
  if (place.pathname.startsWith('/inbox')) {
    const thread = new URLSearchParams(place.search).get('thread');
    if (thread && /^[0-9a-zA-Z_-]{8,64}$/.test(thread)) return { thread };
  }
  return {};
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** 9 AM on that day, in this browser's clock. */
function atNine(d: Date): Date {
  const out = new Date(d);
  out.setHours(9, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function dayLabel(d: Date, now: Date): string {
  const days = Math.round((atNine(d).getTime() - atNine(now).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

/**
 * When a spoken "until Monday", "for 3 days", "next week", "tonight" lands.
 * Null when nothing was said about when.
 */
export function whenSaid(text: string, now: Date): { at: Date; label: string } | null {
  const t = text.toLowerCase();
  let at: Date | null = null;
  const inDays = /\b(?:for|in)\s+(\d+|a|one|two|three|four|five|six|seven)\s+days?\b/.exec(t);
  const words: Record<string, number> = {
    a: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
  };
  if (inDays) {
    const n = Number(inDays[1]) || words[inDays[1]!] || 1;
    at = atNine(addDays(now, n));
  } else if (/\b(?:for|in)\s+(?:a|one)\s+week\b|\bnext week\b/.test(t)) {
    const toMonday = (8 - now.getDay()) % 7 || 7;
    at = atNine(addDays(now, toMonday));
  } else if (/\btonight\b|\bthis evening\b/.test(t)) {
    at = new Date(now);
    at.setHours(18, 0, 0, 0);
    if (at <= now) at = atNine(addDays(now, 1));
  } else if (/\blater today\b|\bthis afternoon\b/.test(t)) {
    at = new Date(now.getTime() + 3 * 3_600_000);
  } else if (/\btomorrow\b/.test(t)) {
    at = atNine(addDays(now, 1));
  } else {
    const day = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (day >= 0) {
      const ahead = (day - now.getDay() + 7) % 7 || 7;
      at = atNine(addDays(now, ahead));
    }
  }
  return at ? { at, label: dayLabel(at, now) } : null;
}

const MEAL = /\b(coffee|lunch|dinner|call|zoom|meet(?:ing)?)\b/;

/** The command in a spoken sentence, or null when it is not one of these. */
export function voiceAction(raw: string, place: VoicePlace, now = new Date()): VoiceAction | null {
  const said = raw
    .replace(/[’]/g, "'")
    .replace(/^(?:hey|hi|ok|okay|so)\b[\s,]*/i, '')
    .replace(/^(?:arwin|erwin|aaron)\b[\s,]*/i, '')
    .replace(/^(?:can you|could you|please|would you)\b[\s,]*/i, '')
    .replace(/[\s.!?]+$/, '')
    .trim();
  const t = said.toLowerCase();
  const here = thisOnScreen(place);

  // Snooze what is open.
  if (
    (/^snooze\b/.test(t) &&
      /\b(this|it|that|the task|this task|this email|this thread)\b|^snooze$/.test(t)) ||
    /^snooze(?:\s+(?:it|this|that))?(?:\s+(?:until|till|til|for|to)\b.*)?$/.test(t)
  ) {
    const when = whenSaid(t, now) ?? {
      at: atNine(addDays(now, 1)),
      label: dayLabel(atNine(addDays(now, 1)), now),
    };
    if (here.task)
      return {
        kind: 'snooze',
        target: 'task',
        id: here.task,
        until: when.at,
        untilLabel: when.label,
      };
    if (here.thread)
      return {
        kind: 'snooze',
        target: 'thread',
        id: here.thread,
        until: when.at,
        untilLabel: when.label,
      };
    return null;
  }

  // Done.
  if (
    /^(?:mark|set)\s+(?:this|it|that|the task|this task)\s+(?:as\s+)?(?:done|complete|completed|finished)$|^(?:this is|it'?s|that'?s)\s+done$|^done with (?:this|it)$|^complete (?:this|it)$/.test(
      t,
    )
  ) {
    return here.task ? { kind: 'done', taskId: here.task } : null;
  }

  // New task.
  const task =
    /^(?:remind\s+(?:me|nick|us)\s+to|add\s+(?:a\s+)?(?:task|to-?do)(?:\s+to|:)?|create\s+(?:a\s+)?task(?:\s+to|:)?|new\s+task(?:\s+to|:)?|(?:i|nick)\s+need(?:s)?\s+to)\s+(.+)$/i.exec(
      said,
    );
  if (task?.[1]) {
    let title = task[1];
    const when = whenSaid(title, now);
    title = title
      .replace(
        /\s+(?:by|on|before|until|for|in|due)\s+(?:tomorrow|tonight|next week|this evening|later today|this afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s+days?|a week)\b.*$/i,
        '',
      )
      .replace(/\s+(?:tomorrow|tonight|next week)$/i, '')
      .trim();
    if (title.length >= 3) {
      title = title[0]!.toUpperCase() + title.slice(1);
      return { kind: 'new_task', title, dueAt: when?.at ?? null, dueLabel: when?.label ?? null };
    }
  }

  // Reply.
  const reply =
    /^(?:draft\s+(?:a\s+)?|write\s+(?:a\s+)?|send\s+(?:a\s+)?)?(?:reply|respond|answer|email back)\s+(?:to\s+)?(.+?)(?:\s*(?::|,|\bsaying\b|\bthat\b|\band say\b|\btelling (?:him|her|them)\b)\s*(.+))?$/i.exec(
      said,
    );
  if (reply?.[1]) {
    const who = reply[1].replace(/'s\s+(?:email|thread|message)$/i, '').trim();
    if (who && who.split(/\s+/).length <= 4 && !/\b(this|it|that)\b/i.test(who)) {
      return { kind: 'reply', who, text: (reply[2] ?? '').trim() };
    }
  }

  // Invite to meet.
  const invite =
    /^(?:book|set up|schedule|arrange|line up|get)\s+(?:(?:nick|me|us)\s+)?(?:a|an)?\s*(coffee|lunch|dinner|call|zoom|meeting)\s+with\s+(.+)$/i.exec(
      said,
    ) ??
    /^(?:invite|ask)\s+(.+?)\s+(?:to|for)\s+(?:a\s+)?(coffee|lunch|dinner|call|zoom|meeting)$/i.exec(
      said,
    );
  if (invite) {
    const [kindWord, who] =
      invite[0].toLowerCase().startsWith('invite') || invite[0].toLowerCase().startsWith('ask')
        ? [invite[2]!, invite[1]!]
        : [invite[1]!, invite[2]!];
    const k = kindWord.toLowerCase();
    const meeting: MealKind | 'call' =
      k === 'coffee' || k === 'lunch' || k === 'dinner' ? k : 'call';
    const name = who.replace(/\s+(?:next week|this week|tomorrow)$/i, '').trim();
    if (name && name.split(/\s+/).length <= 4 && MEAL.test(k))
      return { kind: 'invite', who: name, meeting };
  }
  return null;
}

/** The first name for a greeting: "Sarah Lee" → "Sarah"; an address → its first part, capitalised. */
export function firstName(name: string | null, email: string): string {
  const base = name?.trim() || email.split('@')[0]!.split(/[._-]/)[0]!;
  const first = base.split(/\s+/)[0]!;
  return first ? first[0]!.toUpperCase() + first.slice(1) : 'there';
}

const MEETING_WORDS: Record<MealKind | 'call', string> = {
  coffee: 'grab a coffee',
  lunch: 'grab lunch',
  dinner: 'get dinner',
  call: 'find a time for a quick call',
};

/** The invite email Voice Arwin opens (never sends): Nick's link, opened on that meeting. */
export function inviteEmail(
  to: { name: string | null; email: string },
  meeting: MealKind | 'call',
  origin: string,
): { to: string; subject: string; text: string } {
  const link =
    meeting === 'call' ? `${origin}/meet/nick?type=call` : `${origin}/meet/nick?meal=${meeting}`;
  const what = MEETING_WORDS[meeting];
  return {
    to: to.email,
    subject:
      meeting === 'call'
        ? 'Finding time to talk'
        : `${meeting[0]!.toUpperCase()}${meeting.slice(1)}?`,
    text: `Hi ${firstName(to.name, to.email)},\n\nWould love to ${what}. Here's my calendar, pick whatever works best for you: ${link}\n\nLooking forward to it.`,
  };
}
