import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import {
  classifyMeeting,
  isCalendarNotice,
  listMeetingEvents,
  meetingFromStoredEvent,
  type MeetingEvent,
  type MeetingVerdict,
} from '@/lib/calendar/meetings';
import { listThreadPage, readThreadMeta } from '@/lib/google/gmail-inbox';
import type { CalendarEvent, Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { dayWindow, formatTime } from '@/lib/util/time';
import { getCurrentDossier } from './briefing';
import { readFollowUps, type WeekEvent } from './follow-ups';
import { getPrimaryIntegration } from './inbox';

/**
 * The Calendar tab: Nick's day as it is on Google Calendar, each entry marked
 * Meeting or Block with the reason, and for meetings the "how you got here"
 * context: the daily dossier's section for it (today), the week-ahead prep
 * note (other days), and the last few email threads with the people on it.
 */

export interface DossierSection {
  time: string;
  title: string;
  oneThing: string | null;
  howYouGotHere: string | null;
  worthAsking: string[];
}

const SECTION_HEAD = /^\s*(\d{1,2}:\d{2}\s?[AP]M)\s*[·\-–—|]\s*(.+?)\s*$/i;
const LABEL =
  /^\s*(the one thing to know|how you got here|worth asking|questions to ask)\s*:?\s*(.*)$/i;

/** Split the dossier's plain text into one section per meeting. Pure, for tests. */
export function parseDossier(text: string): DossierSection[] {
  const sections: DossierSection[] = [];
  let current: DossierSection | null = null;
  let field: 'oneThing' | 'howYouGotHere' | 'worthAsking' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = SECTION_HEAD.exec(line);
    if (head) {
      current = {
        time: head[1]!.toUpperCase().replace(/\s?([AP]M)$/, ' $1'),
        title: head[2]!,
        oneThing: null,
        howYouGotHere: null,
        worthAsking: [],
      };
      sections.push(current);
      field = null;
      continue;
    }
    if (!current || !line) continue;
    const label = LABEL.exec(line);
    if (label) {
      const name = label[1]!.toLowerCase();
      field = name.startsWith('the one')
        ? 'oneThing'
        : name.startsWith('how')
          ? 'howYouGotHere'
          : 'worthAsking';
      const rest = label[2]!.trim();
      if (rest) {
        if (field === 'worthAsking') current.worthAsking.push(rest);
        else current[field] = rest;
      }
      continue;
    }
    if (field === 'worthAsking') {
      current.worthAsking.push(line.replace(/^(\d+[.)]|[-•*])\s*/, ''));
    } else if (field) {
      current[field] = current[field] ? `${current[field]} ${line}` : line;
    }
  }
  return sections;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

function overlap(a: string, b: string): number {
  const A = words(a);
  let n = 0;
  for (const w of words(b)) if (A.has(w)) n++;
  return n;
}

export interface RecentThread {
  id: string;
  subject: string;
  at: string | null;
}

export interface CalendarEntry {
  event: MeetingEvent;
  verdict: MeetingVerdict;
  dossier: DossierSection | null;
  prep: string | null;
  recent: RecentThread[];
}

export interface CalendarDay {
  state: 'ok' | 'not_connected' | 'error';
  dateKey: string;
  entries: CalendarEntry[];
  message?: string;
}

const recentCache = processWide(
  'calendar-recent',
  () => new Map<string, { at: number; threads: RecentThread[] }>(),
);
const RECENT_TTL_MS = 30 * 60_000;

async function recentThreads(
  store: DataStore,
  integration: Integration,
  emails: string[],
): Promise<RecentThread[]> {
  if (!emails.length) return [];
  const key = emails.slice().sort().join(',');
  const hit = recentCache.get(key);
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.threads;
  const q = `{${emails.map((e) => `from:${e} to:${e} cc:${e}`).join(' ')}} newer_than:1y`;
  const page = await listThreadPage(store, integration, { q, max: 8 });
  if (!page.ok) return [];
  const metas = await Promise.all(
    page.value.threads.map((t) => readThreadMeta(store, integration, t.id).catch(() => null)),
  );
  // Calendar invites and RSVPs are not conversations: skip them.
  const threads = metas
    .filter((m): m is NonNullable<typeof m> => Boolean(m) && !isCalendarNotice(m!.subject))
    .slice(0, 3)
    .map((m) => ({ id: m.id, subject: m.subject, at: m.latestAt }));
  recentCache.set(key, { at: Date.now(), threads });
  return threads;
}

export async function readCalendarDay(
  store: DataStore,
  organizationId: string,
  options: { dateKey: string; timeZone: string; ownEmail: string; now?: Date },
): Promise<CalendarDay> {
  const { dateKey, timeZone } = options;
  const window = dayWindow(dateKey, timeZone);
  const now = options.now ?? new Date();

  let events: MeetingEvent[];
  let integration: Integration | null = null;
  let own = [options.ownEmail];
  if (isDemoMode()) {
    const rows = (await store.list('calendar_events', organizationId, {})) as CalendarEvent[];
    events = rows
      .filter(
        (r) => r.starts_at >= window.start.toISOString() && r.starts_at < window.end.toISOString(),
      )
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .map(meetingFromStoredEvent);
  } else {
    integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') {
      return { state: 'not_connected', dateKey, entries: [] };
    }
    own = [integration.account_email ?? options.ownEmail].filter(Boolean);
    const listed = await listMeetingEvents(store, integration, window.start, window.end);
    if (!listed.ok) return { state: 'error', dateKey, entries: [], message: listed.error.message };
    events = listed.value;
  }

  // Context sources: today's dossier, and the week-ahead routine's prep notes.
  const [dossierRow, followUps] = await Promise.all([
    getCurrentDossier(store, organizationId).catch(() => null),
    readFollowUps(store, organizationId, { now }).catch(() => null),
  ]);
  const sections =
    dossierRow && dossierRow.date_key === dateKey ? parseDossier(dossierRow.summary) : [];
  const weekEvents: WeekEvent[] =
    followUps?.state === 'ok' ? (followUps.snapshot.weekAhead?.events ?? []) : [];
  const ownDomain = own[0]?.split('@')[1] ?? '';

  // Give each dossier section to the one meeting it is about: the title must
  // share words with it; a matching start time breaks ties. Time alone is not
  // enough, since two meetings can start at the same hour on different days.
  const claimed = new Map<string, DossierSection>();
  const used = new Set<DossierSection>();
  const candidates = events
    .filter((event) => classifyMeeting(event, own).meeting)
    .flatMap((event) => {
      const time = event.startsAt
        ? formatTime(event.startsAt, timeZone).replace(/\s+/g, ' ').toUpperCase()
        : '';
      return sections
        .map((section) => ({
          event,
          section,
          score: overlap(section.title, event.title) * 2 + (section.time === time ? 1 : 0),
          words: overlap(section.title, event.title),
        }))
        .filter((c) => c.words > 0);
    })
    .sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (claimed.has(c.event.id) || used.has(c.section)) continue;
    claimed.set(c.event.id, c.section);
    used.add(c.section);
  }

  const entries = await Promise.all(
    events.map(async (event): Promise<CalendarEntry> => {
      const verdict = classifyMeeting(event, own);
      if (!verdict.meeting) return { event, verdict, dossier: null, prep: null, recent: [] };
      const dossier = claimed.get(event.id) ?? null;
      const week = weekEvents.find(
        (w) =>
          event.startsAt &&
          Math.abs(Date.parse(w.starts_at) - Date.parse(event.startsAt)) < 5 * 60_000,
      );
      const outside = event.attendees
        .filter((a) => !a.resource && !a.self && !a.email.endsWith(`@${ownDomain}`))
        .map((a) => a.email)
        .slice(0, 3);
      const recent = integration
        ? await recentThreads(store, integration, outside).catch(() => [])
        : [];
      return { event, verdict, dossier, prep: week?.prep ?? null, recent };
    }),
  );
  return { state: 'ok', dateKey, entries };
}
