import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { threadLinks } from '@/lib/email/thread-links';
import { evidenceFor } from '@/lib/network/evidence';
import { personPagePath } from '@/lib/network/person-path';
import { evidenceSummary } from '@/lib/network/strength';
import type { Task } from '@/lib/types/domain';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { readCalendarDayEvents } from './calendar-view';
import { readFollowUpsWithin } from './follow-ups';
import { getPrimaryIntegration } from './inbox';
import { getRelationshipIndex, relationshipScope } from './relationships';
import { mailPeopleMatching } from './search';
import { listOpenTasks } from './tasks';

/**
 * Ask Arwin's fast lane: the everyday questions Kraken can answer from what
 * it already holds (today's calendar, open tasks, Follow-ups, the
 * relationship index) in about a second, with no routine and no model, like
 * the job board's instant answers. Anything else, or anything more specific
 * than these shapes, goes to the full Arwin as before. Chat and voice both
 * ask through here, so both get it.
 *
 * Deliberately narrow: a wrong instant answer is worse than a slow right one,
 * so a question only lands here when its whole shape matches.
 */

export type InstantKind =
  'calendar' | 'next_meeting' | 'tasks' | 'waiting_on_us' | 'we_wait' | 'last_contact';

export interface InstantIntent {
  kind: InstantKind;
  /** calendar: 0 today, 1 tomorrow. */
  day?: 0 | 1;
  /** tasks: overdue only, due today only, or everything open. */
  scope?: 'overdue' | 'today' | 'all';
  /** last_contact: the person or company named. */
  who?: string;
}

const WHO_US = '(?:me|nick|us|we|i|him)';

/** What an everyday question asks, or null when it is not one of the fast shapes. */
export function instantIntent(raw: string): InstantIntent | null {
  const q = raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^(?:hey|hi|ok|okay|so)\b[\s,]*/, '')
    .replace(/^(?:arwin|erwin|aaron)\b[\s,]*/, '')
    .replace(/^(?:can you|could you|please|quickly)\b[\s,]*/g, '')
    .replace(/[?.!\s]+$/, '')
    .trim();
  if (!q || q.split(/\s+/).length > 12) return null;

  const day: 0 | 1 | null = /\btomorrow\b/.test(q)
    ? 1
    : /\b(today|tonight|this morning|this afternoon)\b/.test(q)
      ? 0
      : null;
  // "What's on today", "Nick's schedule tomorrow", "what meetings do I have today".
  if (
    day !== null &&
    /^(?:what'?s|what is|whats|show me|tell me|read me|what does|what do|how does|how's|hows)?\s*(?:on\s+)?(?:my|nick'?s|nicks|the|our)?\s*(?:calendar|schedule|agenda|day|meetings?|plan)?\b/.test(
      q,
    ) &&
    /\b(calendar|schedule|agenda|meetings?|on today|on tomorrow|on for today|on for tomorrow|look like|my day|nick'?s day|plan)\b/.test(
      q,
    ) &&
    !/\b(with|about|from|regarding|re)\b/.test(q)
  ) {
    return { kind: 'calendar', day };
  }
  if (
    /^(?:what'?s|what is|when'?s|when is|whats)\s+(?:my|nick'?s|nicks|the|our)\s+next\s+(?:meeting|call)$/.test(
      q,
    ) ||
    /^next\s+(?:meeting|call)$/.test(q)
  ) {
    return { kind: 'next_meeting' };
  }
  if (
    /^(?:what'?s|what is|whats|anything|show me|list)?\s*(?:my\s+|nick'?s\s+|the\s+)?(?:tasks?\s+)?(?:that'?s\s+|that are\s+)?overdue(?:\s+tasks?)?$/.test(
      q,
    )
  ) {
    return { kind: 'tasks', scope: 'overdue' };
  }
  if (
    /^(?:what'?s|what is|whats)\s+due\s+today$/.test(q) ||
    /^(?:tasks|what'?s)\s+due\s+today$/.test(q)
  ) {
    return { kind: 'tasks', scope: 'today' };
  }
  if (
    /^(?:what\s+(?:do|does)\s+(?:i|nick|we)\s+owe(?:\s+(?:people|anyone))?|(?:show\s+me\s+)?(?:my|nick'?s|our)\s+(?:open\s+)?tasks|what'?s\s+on\s+(?:my|nick'?s)\s+(?:plate|to-?do list))$/.test(
      q,
    )
  ) {
    return { kind: 'tasks', scope: 'all' };
  }
  if (
    new RegExp(`^who(?:'s| is| are)?\\s+(?:still\\s+)?waiting\\s+(?:on|for)\\s+${WHO_US}$`).test(q)
  ) {
    return { kind: 'waiting_on_us' };
  }
  if (
    new RegExp(`^who\\s+(?:am|are|is)\\s+${WHO_US}\\s+(?:still\\s+)?waiting\\s+(?:on|for)$`).test(
      q,
    ) ||
    /^who\s+(?:hasn'?t|has not|didn'?t|did not)\s+(?:replied|answered|gotten back)(?:\s+(?:to\s+)?(?:me|nick|us))?$/.test(
      q,
    )
  ) {
    return { kind: 'we_wait' };
  }
  const last = new RegExp(
    `^(?:when\\s+(?:did|was)\\s+(?:${WHO_US}|the last time\\s+${WHO_US})\\s+(?:last\\s+)?(?:talk|speak|spoke|email|e-mail|meet|met|hear|heard|chat|talked)(?:\\s+(?:to|with|from))?|last\\s+(?:contact|touch|email|time we talked)\\s+with)\\s+(.+)$`,
  ).exec(q);
  if (last?.[1]) {
    const who = last[1].replace(/\b(?:last|lately|recently)$/, '').trim();
    if (who && who.split(/\s+/).length <= 4) return { kind: 'last_contact', who };
  }
  return null;
}

export interface InstantAnswer {
  kind: InstantKind;
  /** Plain text, short: read aloud as it is by Voice Arwin. */
  content: string;
  /** Kraken pages it points at, shown as buttons under the answer. */
  links: { label: string; href: string }[];
}

const MAX_BUTTONS = 4;

const MAX_LIST = 8;
const CALENDAR = { label: 'Open Calendar', href: '/calendar' };
const FOLLOW_UPS = { label: 'Open Follow-ups', href: '/follow-ups' };

/** A button label: short enough to sit in a row. */
function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
}

function timeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function dayName(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function dueText(task: Task, timeZone: string): string {
  if (!task.due_at) return '';
  return ` (due ${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(task.due_at))})`;
}

/**
 * The instant answer, or null to send the question on to the full Arwin
 * (not an everyday shape, or the data it needs is not there right now).
 */
export async function answerInstantly(
  store: DataStore,
  auth: AuthContext,
  question: string,
  options: { now?: Date } = {},
): Promise<InstantAnswer | null> {
  const intent = instantIntent(question);
  if (!intent) return null;
  const now = options.now ?? new Date();
  const timeZone = auth.profile.timezone || 'America/Chicago';
  const org = auth.organizationId;
  try {
    switch (intent.kind) {
      case 'calendar':
      case 'next_meeting': {
        const todayKey = localDateKey(now, timeZone);
        const keys =
          intent.kind === 'next_meeting'
            ? [todayKey, addDaysToKey(todayKey, 1), addDaysToKey(todayKey, 2)]
            : [addDaysToKey(todayKey, intent.day ?? 0)];
        const lines: string[] = [];
        for (const dateKey of keys) {
          const day = await readCalendarDayEvents(store, org, {
            dateKey,
            timeZone,
            ownEmail: auth.profile.email,
          });
          if (day.state !== 'ok') return null;
          const events = day.events.filter(
            (e) => !e.allDay && !e.transparent && e.status !== 'cancelled' && e.startsAt,
          );
          if (intent.kind === 'next_meeting') {
            const next = events.find((e) => Date.parse(e.endsAt ?? e.startsAt!) > now.getTime());
            if (next) {
              const when = dateKey === todayKey ? 'today' : dayName(dateKey);
              return {
                kind: intent.kind,
                content: `Next up: ${next.title}, ${when} at ${timeIn(next.startsAt!, timeZone)}.`,
                links: [CALENDAR],
              };
            }
            continue;
          }
          const label = intent.day === 1 ? 'Tomorrow' : 'Today';
          if (events.length === 0) {
            return {
              kind: intent.kind,
              content: `${label} (${dayName(dateKey)}) is clear: no meetings on the calendar.`,
              links: [CALENDAR],
            };
          }
          lines.push(
            `${label} (${dayName(dateKey)}): ${events.length} ${events.length === 1 ? 'meeting' : 'meetings'}.`,
          );
          for (const e of events.slice(0, MAX_LIST)) {
            lines.push(`- ${timeIn(e.startsAt!, timeZone)} ${e.title}`);
          }
          if (events.length > MAX_LIST) lines.push(`- and ${events.length - MAX_LIST} more`);
        }
        if (intent.kind === 'next_meeting') {
          return {
            kind: intent.kind,
            content: 'Nothing else on the calendar for the next couple of days.',
            links: [CALENDAR],
          };
        }
        return { kind: intent.kind, content: lines.join('\n'), links: [CALENDAR] };
      }

      case 'tasks': {
        const open = await listOpenTasks(org, now, store);
        const nowMs = now.getTime();
        const todayKey = localDateKey(now, timeZone);
        const overdue = open.filter((t) => t.due_at && Date.parse(t.due_at) < nowMs);
        const today = open.filter(
          (t) =>
            t.due_at &&
            Date.parse(t.due_at) >= nowMs &&
            localDateKey(new Date(t.due_at), timeZone) === todayKey,
        );
        const pick = intent.scope === 'overdue' ? overdue : intent.scope === 'today' ? today : open;
        const head =
          intent.scope === 'overdue'
            ? overdue.length
              ? `${overdue.length} overdue ${overdue.length === 1 ? 'task' : 'tasks'}, oldest first:`
              : 'Nothing is overdue.'
            : intent.scope === 'today'
              ? today.length
                ? `${today.length} due today:`
                : 'Nothing is due today.'
              : `${open.length} open ${open.length === 1 ? 'task' : 'tasks'}` +
                (overdue.length ? `, ${overdue.length} overdue` : '') +
                '. First up:';
        const lines = [head];
        for (const t of pick.slice(0, MAX_LIST)) {
          lines.push(`- ${t.title}${dueText(t, timeZone)}`);
        }
        if (pick.length > MAX_LIST) lines.push(`- and ${pick.length - MAX_LIST} more`);
        return {
          kind: intent.kind,
          content: lines.join('\n'),
          links: [
            ...pick
              .slice(0, MAX_BUTTONS)
              .map((t) => ({ label: short(t.title), href: `/tasks/${t.id}` })),
            { label: 'Open Tasks', href: '/tasks' },
          ],
        };
      }

      case 'waiting_on_us':
      case 'we_wait': {
        const read = await readFollowUpsWithin(store, org, 2_500, { now });
        if (!read || read.state !== 'ok') return null;
        const integration = await getPrimaryIntegration(store, org).catch(() => null);
        const mailbox = integration?.account_email ?? null;
        const items =
          intent.kind === 'waiting_on_us'
            ? (read.snapshot.relationships?.waiting ?? []).map((r) => ({
                who: r.who,
                company: r.company ?? null,
                days: r.days,
                thread: r.thread_id ?? null,
                note: r.note ?? null,
              }))
            : (read.snapshot.waiting?.items ?? []).map((f) => ({
                who: f.who,
                company: f.company ?? null,
                days: f.days_waiting,
                thread: f.thread_id,
                note: f.subject,
              }));
        if (items.length === 0) {
          return {
            kind: intent.kind,
            content:
              intent.kind === 'waiting_on_us'
                ? 'Nobody on the list is waiting on Nick right now.'
                : 'Nick is not waiting on anyone right now.',
            links: [FOLLOW_UPS],
          };
        }
        const lines = [
          intent.kind === 'waiting_on_us'
            ? `${items.length} waiting on Nick, longest first:`
            : `Nick is waiting on ${items.length}, longest first:`,
        ];
        const sorted = [...items].sort((a, b) => b.days - a.days);
        for (const i of sorted.slice(0, MAX_LIST)) {
          const who = `${i.who}${i.company ? ` (${i.company})` : ''}`;
          lines.push(
            `- ${who}, ${i.days} ${i.days === 1 ? 'day' : 'days'}${i.note ? `: ${i.note}` : ''}`,
          );
        }
        if (items.length > MAX_LIST) lines.push(`- and ${items.length - MAX_LIST} more`);
        const links: InstantAnswer['links'] = [];
        for (const i of sorted) {
          if (links.length >= MAX_BUTTONS) break;
          const href = i.thread ? threadLinks(i.thread, mailbox)?.copilot : null;
          if (href) links.push({ label: short(i.who), href });
        }
        links.push(FOLLOW_UPS);
        return { kind: intent.kind, content: lines.join('\n'), links };
      }

      case 'last_contact': {
        const integration = await getPrimaryIntegration(store, org).catch(() => null);
        const scope = { ...relationshipScope(auth.profile.email, integration), now };
        const loaded = await getRelationshipIndex(store, org, scope);
        if (!loaded.ok) return null;
        const hits = mailPeopleMatching(loaded.value, intent.who!, 2);
        // Only a clear match: two strong candidates is a question for the full Arwin.
        if (hits.length === 0) return null;
        const top = hits[0]!;
        if (hits[1] && hits[1].threads + hits[1].meetings >= top.threads + top.meetings)
          return null;
        const detail = evidenceFor(loaded.value, [top.email], now);
        const summary = evidenceSummary(detail.evidence, now, timeZone);
        const name = top.name ?? top.email;
        return {
          kind: intent.kind,
          content: `${name} (${top.email}): ${summary}.`,
          links: [{ label: `Everything with ${short(name)}`, href: personPagePath(top.email) }],
        };
      }
    }
  } catch {
    // Any hiccup: the full Arwin answers instead.
    return null;
  }
  return null;
}
