import type {
  EventAudience,
  EventDetailTab,
  GuestCounts,
  NotifyKind,
} from '@/lib/events/contracts';
import type {
  CampaignStatus,
  EventAccess,
  EventGuestStatus,
  EventStatus,
  EventVisibility,
} from '@/lib/types/domain';

/**
 * The Events tab's view logic (D-075, WS5): status chips, dates in the
 * venue's time zone, reminder slots, the Ready checklist, next actions, the
 * invite funnel and audience counts. Pure and isomorphic, so the server
 * pages, the client islands and the unit tests share one copy.
 */

/* --------------------------------------------------------------- status */

export type ChipTone =
  'neutral' | 'ok' | 'info' | 'warn' | 'danger' | 'accent' | 'outline' | 'jewel';

export interface StatusChip {
  label: string;
  tone: ChipTone;
}

export interface ChipInput {
  status: EventStatus;
  visibility: EventVisibility;
  access: EventAccess;
  isTemplate: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

/** The time an event is over: its end, else its start. */
export function eventEnd(e: Pick<ChipInput, 'startsAt' | 'endsAt'>): number | null {
  const at = e.endsAt ?? e.startsAt;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Draft / Live / Unlisted / Private / Invite-only / Cancelled / Past / Archived / Template. */
export function statusChip(e: ChipInput, now: Date = new Date()): StatusChip {
  if (e.isTemplate) return { label: 'Template', tone: 'outline' };
  if (e.status === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (e.status === 'cancelled') return { label: 'Cancelled', tone: 'danger' };
  if (e.status === 'archived') return { label: 'Archived', tone: 'neutral' };
  const end = eventEnd(e);
  if (end !== null && end < now.getTime()) return { label: 'Past', tone: 'neutral' };
  if (e.access === 'invite_only') return { label: 'Invite-only', tone: 'jewel' };
  if (e.visibility === 'unlisted') return { label: 'Unlisted', tone: 'info' };
  if (e.visibility === 'private') return { label: 'Private', tone: 'info' };
  return { label: 'Live', tone: 'ok' };
}

/* ---------------------------------------------------------------- dates */

function fmt(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(date);
  }
}

function sameDay(a: Date, b: Date, timeZone: string): boolean {
  const key = (d: Date) => fmt(d, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return key(a) === key(b);
}

/**
 * When an event or session happens, in the venue's time zone:
 * "Sat, Jan 25, 2027 · 1:00 PM – 9:00 PM CST", or across days
 * "Jan 25 – Jan 26, 2027". "Date not set" without a start.
 */
export function formatWhen(
  startsAt: string | null,
  endsAt: string | null,
  timeZone: string,
): string {
  const start = startsAt ? new Date(startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return 'Date not set';
  const end = endsAt ? new Date(endsAt) : null;
  const validEnd = end && !Number.isNaN(end.getTime()) && end > start ? end : null;
  const day = fmt(start, timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = (d: Date, zone: boolean) =>
    fmt(d, timeZone, {
      hour: 'numeric',
      minute: '2-digit',
      ...(zone ? { timeZoneName: 'short' } : {}),
    });
  if (!validEnd) return `${day} · ${time(start, true)}`;
  if (sameDay(start, validEnd, timeZone)) {
    return `${day} · ${time(start, false)} – ${time(validEnd, true)}`;
  }
  const short = (d: Date) => fmt(d, timeZone, { month: 'short', day: 'numeric' });
  const year = fmt(validEnd, timeZone, { year: 'numeric' });
  return `${short(start)} – ${short(validEnd)}, ${year}`;
}

/** "Jan 25" style day, for compact rows. */
export function formatDay(at: string | null, timeZone: string): string {
  if (!at || Number.isNaN(Date.parse(at))) return 'No date';
  return fmt(new Date(at), timeZone, { month: 'short', day: 'numeric' });
}

/** "Jan 25, 1:00 PM CST": a reminder's due time and the like. */
export function formatMoment(at: string, timeZone: string): string {
  return fmt(new Date(at), timeZone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/* ------------------------------------------------------------ reminders */

/** The default reminder offsets: one week, one day and three hours before. */
export const DEFAULT_REMINDER_OFFSETS = [10_080, 1_440, 180] as const;
/** The quick picks the Messages tab offers. */
export const REMINDER_OFFSET_CHOICES = [20_160, 10_080, 4_320, 1_440, 360, 180, 60] as const;
export const MAX_REMINDER_OFFSETS = 6;
/** Sixty days, in minutes. */
export const MAX_REMINDER_OFFSET = 86_400;

/** "1 week before", "1 day before", "3 hours before", "90 minutes before". */
export function offsetLabel(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 10_080 === 0) return `${plural(minutes / 10_080, 'week')} before`;
  if (minutes % 1_440 === 0) return `${plural(minutes / 1_440, 'day')} before`;
  if (minutes % 60 === 0) return `${plural(minutes / 60, 'hour')} before`;
  return `${plural(minutes, 'minute')} before`;
}

/** Valid, unique offsets, longest first, at most six. Null when any is out of range. */
export function cleanOffsets(raw: readonly number[]): number[] | null {
  const out: number[] = [];
  for (const n of raw) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_REMINDER_OFFSET) return null;
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_REMINDER_OFFSETS) return null;
  return out.sort((a, b) => b - a);
}

export type ReminderState = 'scheduled' | 'due' | 'drafted' | 'sent' | 'missed';

export interface ReminderSlot {
  /** `<session id>:<offset minutes>`. */
  key: string;
  sessionId: string;
  sessionName: string;
  offsetMinutes: number;
  label: string;
  dueAt: string;
  startsAt: string;
  state: ReminderState;
  /** The reminder draft (or send) for this slot, when there is one. */
  campaignId: string | null;
}

export interface ReminderCampaign {
  id: string;
  status: CampaignStatus;
  sessionId: string | null;
  offsetMinutes: number | null;
}

/**
 * Every reminder an event's schedule calls for: each session × each offset,
 * soonest due first. A slot with a live draft is "drafted", one whose draft
 * went out is "sent"; otherwise "scheduled" before it falls due, "due" from
 * then until the session starts, and "missed" after. Nothing here sends.
 */
export function reminderSlots(
  sessions: readonly { id: string; name: string; starts_at: string | null }[],
  offsets: readonly number[],
  reminders: readonly ReminderCampaign[],
  now: Date = new Date(),
): ReminderSlot[] {
  const out: ReminderSlot[] = [];
  for (const session of sessions) {
    const start = session.starts_at ? Date.parse(session.starts_at) : NaN;
    if (!Number.isFinite(start)) continue;
    for (const offset of offsets) {
      const due = start - offset * 60_000;
      const mine = reminders.filter(
        (r) => r.sessionId === session.id && r.offsetMinutes === offset && r.status !== 'cancelled',
      );
      const sent = mine.find((r) => r.status !== 'draft');
      const draft = mine.find((r) => r.status === 'draft');
      const state: ReminderState = sent
        ? 'sent'
        : draft
          ? 'drafted'
          : now.getTime() < due
            ? 'scheduled'
            : now.getTime() < start
              ? 'due'
              : 'missed';
      out.push({
        key: `${session.id}:${offset}`,
        sessionId: session.id,
        sessionName: session.name,
        offsetMinutes: offset,
        label: offsetLabel(offset),
        dueAt: new Date(due).toISOString(),
        startsAt: new Date(start).toISOString(),
        state,
        campaignId: (sent ?? draft)?.id ?? null,
      });
    }
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** A reminder that wants a person now: due and not drafted, or drafted and past its time. */
export function reminderNeedsYou(slot: ReminderSlot, now: Date = new Date()): boolean {
  if (slot.state === 'due') return true;
  return slot.state === 'drafted' && Date.parse(slot.dueAt) <= now.getTime();
}

/* ------------------------------------------------------------ checklist */

export interface ReadyItem {
  key: 'details' | 'page' | 'guests' | 'published' | 'invites' | 'reminders' | 'seo';
  label: string;
  done: boolean;
  detail: string;
  /** Where to fix it: a tab of this event, or Studio. */
  tab: EventDetailTab | 'studio';
}

export interface ReadinessInput {
  status: EventStatus;
  access: EventAccess;
  visibility: EventVisibility;
  startsAt: string | null;
  venueSet: boolean;
  sessions: number;
  publishedAt: string | null;
  /** draft_version - published_draft_version, when published. */
  unpublishedChanges: number;
  sectionCount: number;
  hasRsvpBlock: boolean;
  registrationOpen: boolean;
  guests: number;
  invitesSent: number;
  invitesDrafted: number;
  reminderOffsets: number;
  seoDescription: string;
}

/** The Ready checklist on Overview, in the order an event is put together. */
export function readinessChecklist(input: ReadinessInput): ReadyItem[] {
  const items: ReadyItem[] = [];
  const dateSet = Boolean(input.startsAt);
  items.push({
    key: 'details',
    label: 'Date and place',
    done: dateSet && input.venueSet,
    detail: !dateSet
      ? 'No date yet. Set the session times in Registration.'
      : input.venueSet
        ? `${input.sessions} ${input.sessions === 1 ? 'session' : 'sessions'}, venue set.`
        : 'Add the venue (or the online link).',
    tab: 'registration',
  });
  items.push({
    key: 'page',
    label: 'Page built',
    done: input.hasRsvpBlock && input.sectionCount >= 3,
    detail: input.hasRsvpBlock
      ? `${input.sectionCount} sections, with an RSVP card.`
      : 'Add an RSVP card so guests can answer.',
    tab: 'studio',
  });
  const invitesFirst = input.access !== 'open';
  items.push({
    key: 'guests',
    label: invitesFirst ? 'Guests added' : 'Registration open',
    done: invitesFirst ? input.guests > 0 : input.registrationOpen,
    detail: invitesFirst
      ? input.guests > 0
        ? `${input.guests} on the list.`
        : 'Add guests from Copilot, a CSV or pasted emails.'
      : input.registrationOpen
        ? 'Anyone with the link can RSVP.'
        : 'Registration is closed.',
    tab: invitesFirst ? 'guests' : 'registration',
  });
  const published = input.publishedAt !== null && input.status !== 'draft';
  items.push({
    key: 'published',
    label: 'Page published',
    done: published,
    detail: !published
      ? 'Nothing is public until you publish from Studio.'
      : input.unpublishedChanges > 0
        ? `Live. ${input.unpublishedChanges} ${input.unpublishedChanges === 1 ? 'change is' : 'changes are'} not published yet.`
        : 'Live, and up to date.',
    tab: 'studio',
  });
  if (invitesFirst) {
    items.push({
      key: 'invites',
      label: 'Invites sent',
      done: input.invitesSent > 0,
      detail:
        input.invitesSent > 0
          ? `${input.invitesSent} ${input.invitesSent === 1 ? 'invite' : 'invites'} sent.`
          : input.invitesDrafted > 0
            ? 'An invite draft is waiting for your review.'
            : 'Draft the invite in Messages. You review it before anything goes.',
      tab: 'messages',
    });
  }
  items.push({
    key: 'reminders',
    label: 'Reminders planned',
    done: input.reminderOffsets > 0,
    detail:
      input.reminderOffsets > 0
        ? `${input.reminderOffsets} ${input.reminderOffsets === 1 ? 'reminder' : 'reminders'} per session, each a draft you send.`
        : 'No reminders planned.',
    tab: 'messages',
  });
  if (input.visibility === 'public') {
    items.push({
      key: 'seo',
      label: 'Search and share text',
      done: input.seoDescription.trim().length > 0,
      detail: input.seoDescription.trim()
        ? 'Description set for search and link previews.'
        : 'Add a one-line description for search and link previews.',
      tab: 'settings',
    });
  }
  return items;
}

/* --------------------------------------------------------- next actions */

export interface NextAction {
  key: string;
  label: string;
  /** App-relative link. */
  href: string;
  urgent: boolean;
}

export interface NextActionInput {
  eventId: string;
  status: EventStatus;
  pending: number;
  needsNotifying: number;
  remindersReady: number;
  outsideEdits: number;
  unpublishedChanges: number;
  updateFor: number | null;
  cancellationFor: number | null;
  firstOpenItem: ReadyItem | null;
}

function tabHrefOf(eventId: string, tab: EventDetailTab | 'studio'): string {
  if (tab === 'studio') return `/events/${eventId}/studio`;
  return tab === 'overview' ? `/events/${eventId}` : `/events/${eventId}?tab=${tab}`;
}

/** What to do next on an event, most pressing first, at most four. */
export function nextActions(input: NextActionInput): NextAction[] {
  const out: NextAction[] = [];
  const href = (tab: EventDetailTab | 'studio') => tabHrefOf(input.eventId, tab);
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (input.cancellationFor !== null) {
    out.push({
      key: 'cancellation',
      label: `Draft a cancellation notice to ${n(input.cancellationFor, 'guest', 'guests')}`,
      href: href('messages'),
      urgent: true,
    });
  }
  if (input.updateFor !== null) {
    out.push({
      key: 'update',
      label: `The time or place changed: draft an update to ${n(input.updateFor, 'going guest', 'going guests')}`,
      href: href('messages'),
      urgent: true,
    });
  }
  if (input.pending > 0) {
    out.push({
      key: 'pending',
      label: `${n(input.pending, 'person is', 'people are')} waiting for approval`,
      href: href('guests'),
      urgent: true,
    });
  }
  if (input.needsNotifying > 0) {
    out.push({
      key: 'notify',
      label: `${n(input.needsNotifying, 'guest needs', 'guests need')} to hear about a status change`,
      href: href('messages'),
      urgent: true,
    });
  }
  if (input.remindersReady > 0) {
    out.push({
      key: 'reminder',
      label:
        input.remindersReady === 1
          ? 'A reminder is ready: review and send'
          : `${input.remindersReady} reminders are ready: review and send`,
      href: href('messages'),
      urgent: true,
    });
  }
  if (input.outsideEdits > 0) {
    out.push({
      key: 'outside',
      label: `${n(input.outsideEdits, 'outside edit', 'outside edits')} to look over and publish`,
      href: href('studio'),
      urgent: false,
    });
  } else if (input.status === 'published' && input.unpublishedChanges > 0) {
    out.push({
      key: 'publish',
      label: `${n(input.unpublishedChanges, 'change is', 'changes are')} not live yet: publish from Studio`,
      href: href('studio'),
      urgent: false,
    });
  }
  if (input.firstOpenItem && out.length < 4) {
    out.push({
      key: `ready-${input.firstOpenItem.key}`,
      label: `${input.firstOpenItem.label}: ${input.firstOpenItem.detail}`,
      href: href(input.firstOpenItem.tab),
      urgent: false,
    });
  }
  return out.slice(0, 4);
}

/* --------------------------------------------------------------- guests */

export interface GuestRow {
  id: string;
  email: string | null;
  parent_guest_id: string | null;
  tags: string[];
}

export interface GuestSessionRow {
  guest_id: string;
  session_id: string;
  status: EventGuestStatus;
  checked_in_at: string | null;
}

const STATUS_RANK: EventGuestStatus[] = [
  'going',
  'pending',
  'waitlist',
  'maybe',
  'invited',
  'not_going',
  'declined',
];

/** A guest's status across sessions: the strongest one (as WS4's guestLevelStatus). */
export function overallStatus(statuses: readonly EventGuestStatus[]): EventGuestStatus {
  for (const status of STATUS_RANK) if (statuses.includes(status)) return status;
  return 'invited';
}

function rowsByGuest(rows: readonly GuestSessionRow[]): Map<string, GuestSessionRow[]> {
  const out = new Map<string, GuestSessionRow[]>();
  for (const row of rows) {
    const list = out.get(row.guest_id) ?? [];
    list.push(row);
    out.set(row.guest_id, list);
  }
  return out;
}

/**
 * The guests an audience names, among those with an email address: a
 * PREVIEW count for the Messages tab's picker. The draft itself is built from
 * WS4's resolveAudience, which is the authority on who gets it.
 */
export function audienceGuestIds(
  guests: readonly GuestRow[],
  rows: readonly GuestSessionRow[],
  audience: EventAudience,
): string[] {
  const byGuest = rowsByGuest(rows);
  const withEmail = guests.filter((g) => Boolean(g.email));
  if (audience.kind === 'guests') {
    const wanted = new Set(audience.guestIds);
    return withEmail.filter((g) => wanted.has(g.id)).map((g) => g.id);
  }
  const sessionId = audience.sessionId ?? null;
  return withEmail
    .filter((g) => {
      const mine = byGuest.get(g.id) ?? [];
      const scoped = sessionId ? mine.filter((r) => r.session_id === sessionId) : mine;
      if (sessionId && scoped.length === 0) return false;
      switch (audience.kind) {
        case 'all':
          return true;
        case 'status': {
          const status = sessionId
            ? (scoped[0]?.status ?? 'invited')
            : overallStatus(mine.map((r) => r.status));
          return audience.statuses.includes(status);
        }
        case 'tag':
          return g.tags.some((t) => t.toLowerCase() === audience.tag.toLowerCase());
        case 'checked_in':
          return scoped.some((r) => r.checked_in_at);
      }
    })
    .map((g) => g.id);
}

/** Tags on an event's guests, most used first, with how many carry each. */
export function tagCounts(guests: readonly GuestRow[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const g of guests) {
    for (const tag of g.tags) {
      const key = tag.toLowerCase();
      const entry = counts.get(key) ?? { tag, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* --------------------------------------------------------------- funnel */

export interface FunnelRecipient {
  email: string;
  status: 'pending' | 'sent' | 'failed' | 'unconfirmed' | 'skipped';
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  replied_at: string | null;
}

export interface FunnelSession {
  sessionId: string;
  name: string;
  invited: number;
  responded: number;
  going: number;
}

export interface Funnel {
  invited: number;
  delivered: number;
  opened: number;
  viewed: number;
  responded: number;
  going: number;
  perSession: FunnelSession[];
  /** Guest ids for the one-click nudges. */
  segments: { openedNoReply: string[]; neverOpened: string[] };
}

/**
 * The invite funnel: invited → delivered → opened → viewed the page →
 * responded → going, counted over the guests a sent invite went to (matched
 * by email; plus-ones are not invited, so they are left out). The two nudge
 * segments are the invited guests who have not answered yet.
 */
export function computeFunnel(input: {
  guests: readonly GuestRow[];
  rows: readonly GuestSessionRow[];
  sessions: readonly { id: string; name: string }[];
  /** Recipients of the event's invites and nudges that left draft. */
  recipients: readonly FunnelRecipient[];
  /** Guests whose personal page was viewed (the beacon). */
  viewed: ReadonlySet<string>;
}): Funnel {
  const byEmail = new Map<string, FunnelRecipient[]>();
  for (const r of input.recipients) {
    if (r.status === 'skipped') continue;
    const key = r.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(r);
    byEmail.set(key, list);
  }
  const byGuest = rowsByGuest(input.rows);
  const funnel: Funnel = {
    invited: 0,
    delivered: 0,
    opened: 0,
    viewed: 0,
    responded: 0,
    going: 0,
    perSession: input.sessions.map((s) => ({
      sessionId: s.id,
      name: s.name,
      invited: 0,
      responded: 0,
      going: 0,
    })),
    segments: { openedNoReply: [], neverOpened: [] },
  };
  for (const guest of input.guests) {
    if (guest.parent_guest_id || !guest.email) continue;
    const sent = byEmail.get(guest.email.toLowerCase());
    if (!sent?.length) continue;
    const mine = byGuest.get(guest.id) ?? [];
    const statuses = mine.map((r) => r.status);
    const delivered = sent.some((r) => r.sent_at && !r.bounced_at);
    const opened = sent.some((r) => r.opened_at || r.clicked_at);
    const responded = statuses.some((s) => s !== 'invited');
    const going = overallStatus(statuses) === 'going';
    funnel.invited += 1;
    if (delivered) funnel.delivered += 1;
    if (opened) funnel.opened += 1;
    if (input.viewed.has(guest.id)) funnel.viewed += 1;
    if (responded) funnel.responded += 1;
    if (going) funnel.going += 1;
    if (!responded && opened) funnel.segments.openedNoReply.push(guest.id);
    if (!responded && delivered && !opened) funnel.segments.neverOpened.push(guest.id);
    for (const row of mine) {
      const session = funnel.perSession.find((s) => s.sessionId === row.session_id);
      if (!session) continue;
      session.invited += 1;
      if (row.status !== 'invited') session.responded += 1;
      if (row.status === 'going') session.going += 1;
    }
  }
  return funnel;
}

/* ---------------------------------------------------------------- words */

export const NOTIFY_LABELS: Record<NotifyKind, { title: string; draft: string }> = {
  confirmed: { title: 'Confirmed', draft: 'Draft “You’re confirmed”' },
  waitlisted: { title: 'On the waitlist', draft: 'Draft “We’re full: you’re on the waitlist”' },
  promoted: { title: 'Off the waitlist', draft: 'Draft “A spot opened”' },
  declined: { title: 'Declined', draft: 'Draft “Sorry, we can’t fit you in”' },
  pending: { title: 'Request received', draft: 'Draft “We got your request”' },
};

export const STATUS_LABELS: Record<EventGuestStatus, string> = {
  going: 'Going',
  pending: 'Pending',
  waitlist: 'Waitlist',
  maybe: 'Maybe',
  invited: 'Invited, no reply',
  not_going: 'Not going',
  declined: 'Declined',
};

/** The library card's counts line: "12 going · 3 pending · 2 waitlist". */
export function countsLine(counts: GuestCounts): string {
  const parts = [`${counts.going} going`];
  if (counts.pending) parts.push(`${counts.pending} pending`);
  if (counts.waitlist) parts.push(`${counts.waitlist} waitlist`);
  if (!counts.pending && !counts.waitlist && counts.invited)
    parts.push(`${counts.invited} invited`);
  return parts.join(' · ');
}
