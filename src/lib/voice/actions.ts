import { addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';

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

/** This device's time zone, or Central (Nick's) when it cannot say. */
function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

/** 9 AM (or `hour`) on the day `days` from today, in `zone`. */
function onDay(now: Date, zone: string, days: number, hour = 9): Date {
  const key = addDaysToKey(localDateKey(now, zone), days);
  return wallTimeToUtc(key, hour, 0, zone) ?? new Date(now.getTime() + days * 86_400_000);
}

function weekdayIn(now: Date, zone: string): number {
  const key = localDateKey(now, zone);
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function dayLabel(d: Date, now: Date, zone: string): string {
  const time = d.toLocaleTimeString('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const today = localDateKey(now, zone);
  const key = localDateKey(d, zone);
  if (key === today) return `today at ${time}`;
  if (key === addDaysToKey(today, 1)) return `tomorrow at ${time}`;
  const day = d.toLocaleDateString('en-US', {
    timeZone: zone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  return `${day} at ${time}`;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

/**
 * When a spoken "until Monday", "for 3 days", "next week", "tonight" lands,
 * read in `zone` (the device's own by default). When a sentence names more
 * than one ("Thursday… oh sorry, let's do it tomorrow"), the last one said
 * wins. Null when nothing was said about when.
 */
export function whenSaid(
  text: string,
  now: Date,
  zone: string = deviceZone(),
): { at: Date; label: string } | null {
  const t = text.toLowerCase();
  const found: { index: number; at: () => Date }[] = [];
  const each = (re: RegExp, at: (m: RegExpExecArray) => Date) => {
    for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
      const match = m as unknown as RegExpExecArray;
      found.push({ index: m.index ?? 0, at: () => at(match) });
    }
  };
  each(/\b(?:for|in)\s+(\d+|a|one|two|three|four|five|six|seven)\s+days?\b/, (m) =>
    onDay(now, zone, Number(m[1]) || NUMBER_WORDS[m[1]!] || 1),
  );
  each(/\b(?:for|in)\s+(?:a|one)\s+week\b|\bnext week\b/, () =>
    onDay(now, zone, (8 - weekdayIn(now, zone)) % 7 || 7),
  );
  each(/\btonight\b|\bthis evening\b/, () => {
    const evening = onDay(now, zone, 0, 18);
    return evening > now ? evening : onDay(now, zone, 1);
  });
  each(/\blater today\b|\bthis afternoon\b/, () => new Date(now.getTime() + 3 * 3_600_000));
  each(/\btomorrow\b/, () => onDay(now, zone, 1));
  WEEKDAYS.forEach((name, day) =>
    each(new RegExp(`\\b${name}\\b`), () =>
      onDay(now, zone, (day - weekdayIn(now, zone) + 7) % 7 || 7),
    ),
  );
  if (!found.length) return null;
  const last = found.reduce((a, b) => (b.index >= a.index ? b : a));
  const at = last.at();
  return { at, label: dayLabel(at, now, zone) };
}

const WHEN_WORDS =
  '(?:tomorrow|tonight|today|next week|this evening|later today|this afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d+\\s+days?|a week)';

/**
 * "Remind me on Thursday that we're supposed to talk about Affinity. Oh,
 * sorry, let's do it tomorrow", "remind me to send Dana the deck by Friday",
 * "add a task to call Brightwave": a new task. The title is what is to be
 * done; the due day is the last one said, so a correction wins.
 */
export function taskCommand(said: string, now: Date, zone?: string): VoiceAction | null {
  const head =
    /^(?:remind\s+(?:me|nick|us|him)|set\s+(?:a\s+)?reminder|add\s+(?:a\s+)?(?:task|to-?do|reminder)|create\s+(?:a\s+)?(?:task|reminder)|new\s+task|(?:i|nick|we)\s+needs?\s+to)\b[\s,:]*(.*)$/is.exec(
      said,
    );
  if (!head) return null;
  const when = whenSaid(said, now, zone);
  // The first sentence holds the task; later ones are corrections ("let's do it tomorrow").
  let title = (head[1] ?? '').split(/(?<=[.!?])\s+/)[0]!.replace(/[.!?]+$/, '');
  const lead = new RegExp(`^(?:(?:on|by|this|next|before|for)\\s+)?${WHEN_WORDS}\\b[\\s,]*`, 'i');
  for (let i = 0; i < 3; i++) {
    title = title
      .replace(lead, '')
      .replace(/^(?:to|that|about|of|for|:)\s+/i, '')
      .trim();
  }
  title = title
    .replace(
      /^(?:we're|we are|i'm|i am|nick is|nick's)\s+(?:supposed|meant|going)\s+to\s+|^(?:we|i|nick)\s+(?:need|needs|should|have|has|must)\s+(?:to\s+)?/i,
      '',
    )
    .replace(
      new RegExp(`\\s+(?:by|on|before|until|for|in|due|this|next)\\s+${WHEN_WORDS}\\b.*$`, 'i'),
      '',
    )
    .replace(new RegExp(`\\s+${WHEN_WORDS}$`, 'i'), '')
    .trim();
  if (title.replace(/[^\p{L}]/gu, '').length < 3) return null;
  title = title[0]!.toUpperCase() + title.slice(1);
  return { kind: 'new_task', title, dueAt: when?.at ?? null, dueLabel: when?.label ?? null };
}

const MEAL = /\b(coffee|lunch|dinner|call|zoom|meet(?:ing)?)\b/;

/** The command in a spoken sentence, or null when it is not one of these. */
export function voiceAction(
  raw: string,
  place: VoicePlace,
  now = new Date(),
  zone?: string,
): VoiceAction | null {
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
    const when = whenSaid(t, now, zone) ?? whenSaid('tomorrow', now, zone)!;
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
  const task = taskCommand(said, now, zone);
  if (task) return task;

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
