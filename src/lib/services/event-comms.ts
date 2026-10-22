import 'server-only';
import { z } from 'zod';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import type { EventAudience, NotifyKind } from '@/lib/events/contracts';
import { messageCopy, type MessageContext } from '@/lib/events/message-copy';
import { entityId, guestTag } from '@/lib/events/schema';
import {
  STATUS_LABELS,
  audienceGuestIds,
  cleanOffsets,
  computeFunnel,
  formatWhen,
  reminderNeedsYou,
  reminderSlots,
  tagCounts,
  type Funnel,
  type GuestRow,
  type GuestSessionRow,
  type ReminderSlot,
} from '@/lib/events/tab-view';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import {
  addEventRecipients,
  createCampaign,
  listEventCampaigns,
  recipientsOfCampaigns,
  setEventCampaignMeta,
  updateCampaign,
  type CampaignSummary,
} from '@/lib/services/campaigns';
import { getEvent, getEventSessions, type EventOwner } from '@/lib/services/events';
import { markNotified, needsNotifying, resolveAudience } from '@/lib/services/event-guests';
import type {
  CampaignFromIdentity,
  EventCampaignKind,
  EventComms,
  EventGuestStatus,
  EventRecord,
  EventSession,
} from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Event messages (D-075, WS5): invites, reminders, status notices, update
 * and cancellation notices, blasts and nudges.
 *
 * THE RULE: nothing here sends. Each function builds a campaign DRAFT through
 * the campaigns service (lib/services/campaigns.ts): its subject and body in
 * the event's words, its recipients from the event's guest list, each with
 * their personal {{rsvp_link}}. A person opens it in the campaign review and
 * taps Send, which is where the daily cap (400), the recipient limit (2,000),
 * the send lease and the confirmed-version check all apply, unchanged.
 *
 * Who a draft goes to comes from WS4's guest service (resolveAudience), the
 * authority on statuses and personal links. The "Needs notifying" queue is
 * WS4's needsNotifying, minus what a live draft already covers; a notice's
 * status changes are marked as told (markNotified) only once its campaign has
 * actually sent, when this module next reads the event (reconcileNotices).
 *
 * Reminders are drafts too: the schedule (comms.reminder_offsets_minutes)
 * says when each one falls due; Today, the phone and the desktop app then
 * say "reminder ready", and a person drafts and sends it.
 */

/* ---------------------------------------------------------------- input */

export const EVENT_MESSAGE_KINDS = [
  'invite',
  'reminder',
  'notice',
  'update',
  'cancellation',
  'blast',
  'nudge',
] as const satisfies readonly EventCampaignKind[];

const NOTIFY_KINDS = [
  'confirmed',
  'waitlisted',
  'promoted',
  'declined',
  'pending',
] as const satisfies readonly NotifyKind[];

const GUEST_STATUSES = [
  'invited',
  'pending',
  'going',
  'maybe',
  'waitlist',
  'declined',
  'not_going',
] as const satisfies readonly EventGuestStatus[];

const SEGMENTS = ['opened_no_reply', 'never_opened'] as const;
export type NudgeSegment = (typeof SEGMENTS)[number];

const sessionRef = entityId.nullable().optional();

/** An EventAudience (lib/events/contracts.ts) as a request carries it. */
export const eventAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all'), sessionId: sessionRef }),
  z.strictObject({
    kind: z.literal('status'),
    statuses: z.array(z.enum(GUEST_STATUSES)).min(1).max(GUEST_STATUSES.length),
    sessionId: sessionRef,
  }),
  z.strictObject({ kind: z.literal('tag'), tag: guestTag, sessionId: sessionRef }),
  z.strictObject({ kind: z.literal('checked_in'), sessionId: sessionRef }),
  z.strictObject({ kind: z.literal('guests'), guestIds: z.array(entityId).min(1).max(2000) }),
]);

/** POST /api/events/[id]/campaign. */
export const eventMessageRequest = z.strictObject({
  kind: z.enum(EVENT_MESSAGE_KINDS),
  audience: eventAudienceSchema.optional(),
  sessionId: entityId.nullable().optional(),
  offsetMinutes: z.number().int().min(1).max(86_400).optional(),
  notifyKind: z.enum(NOTIFY_KINDS).optional(),
  segment: z.enum(SEGMENTS).optional(),
  sender: z.enum(['nick', 'arwin']).optional(),
});
export type EventMessageRequest = z.infer<typeof eventMessageRequest>;

/* ---------------------------------------------------------- bookkeeping */

const notifyItem = z.object({
  guestId: z.string().max(64),
  sessionId: z.string().max(64),
  status: z.enum(GUEST_STATUSES),
  email: z.string().max(320).nullable().optional(),
});
export type NotifyItem = z.infer<typeof notifyItem>;

/**
 * What an event draft was built from, kept on the campaign (event_meta). Read
 * leniently: an unreadable value reads as empty, never as a crash.
 */
export const eventCampaignMeta = z.object({
  audience: eventAudienceSchema.optional(),
  audienceLabel: z.string().max(200).optional(),
  sessionId: z.string().max(64).nullable().optional(),
  offsetMinutes: z.number().int().optional(),
  notifyKind: z.enum(NOTIFY_KINDS).optional(),
  notify: z.array(notifyItem).max(5000).optional(),
  scheduleVersion: z.number().int().optional(),
  segment: z.enum(SEGMENTS).optional(),
  /** When a sent notice's status changes were marked as told. */
  reconciledAt: z.string().max(40).nullable().optional(),
});
export type EventCampaignMeta = z.infer<typeof eventCampaignMeta>;

export function readMeta(raw: unknown): EventCampaignMeta {
  const parsed = eventCampaignMeta.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/* ------------------------------------------------------------- context */

/** The event's facts as the copy needs them, in the venue's time zone. */
export function messageContext(
  event: EventRecord,
  sessions: readonly EventSession[],
): MessageContext {
  return {
    title: event.title,
    when: formatWhen(event.starts_at, event.ends_at, event.time_zone),
    venueName: event.venue && event.venue.kind !== 'online' ? (event.venue.name ?? null) : null,
    sessions: sessions.map((s) => ({
      name: s.name,
      when: formatWhen(s.starts_at, s.ends_at, event.time_zone),
    })),
    cancelMessage: event.cancel_message,
  };
}

/** "Going · Evening Reception", "Tag: LP", "3 chosen guests". */
export function audienceLabel(
  audience: EventAudience,
  sessions: readonly Pick<EventSession, 'id' | 'name'>[],
): string {
  const session =
    'sessionId' in audience && audience.sessionId
      ? sessions.find((s) => s.id === audience.sessionId)?.name
      : null;
  const scoped = (text: string) => (session ? `${text} · ${session}` : text);
  switch (audience.kind) {
    case 'all':
      return scoped('Everyone on the list');
    case 'status':
      return scoped(audience.statuses.map((s) => STATUS_LABELS[s]).join(', '));
    case 'tag':
      return scoped(`Tag: ${audience.tag}`);
    case 'checked_in':
      return scoped('Checked in');
    case 'guests':
      return `${audience.guestIds.length} chosen ${audience.guestIds.length === 1 ? 'guest' : 'guests'}`;
  }
}

/* ---------------------------------------------------------- guest reads */

export interface GuestSnapshot {
  guests: GuestRow[];
  rows: GuestSessionRow[];
  /** Guests whose personal page was viewed (event_page_views, v1 nice). */
  viewed: Set<string>;
  /** Guests who registered in the last 24 hours. */
  newSince: (since: Date) => number;
}

/**
 * The event's guests and their session rows, read straight from the tables
 * (read-only; WS4's service owns every write). A missing table reads as an
 * empty list.
 */
export async function readGuestSnapshot(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<GuestSnapshot> {
  const read = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch (error) {
      if (!isMissingTableError(error)) {
        log.warn('Event guest read failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  };
  const [guests, rows, views] = await Promise.all([
    read(() => store.list('event_guests', organizationId, { eq: { event_id: eventId } })),
    read(() => store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } })),
    read(() =>
      store.list(
        'event_page_views',
        organizationId,
        { eq: { event_id: eventId }, notNull: ['guest_id'] },
        { limit: 5000 },
      ),
    ),
  ]);
  return {
    guests: guests.map((g) => ({
      id: g.id,
      email: g.email,
      parent_guest_id: g.parent_guest_id,
      tags: g.tags ?? [],
    })),
    rows: rows.map((r) => ({
      guest_id: r.guest_id,
      session_id: r.session_id,
      status: r.status,
      checked_in_at: r.checked_in_at,
    })),
    viewed: new Set(views.map((v) => v.guest_id).filter((id): id is string => Boolean(id))),
    newSince: (since) =>
      guests.filter(
        (g) =>
          !g.parent_guest_id && g.registered_at && Date.parse(g.registered_at) >= since.getTime(),
      ).length,
  };
}

/* --------------------------------------------------------- the funnel */

const FUNNEL_KINDS: readonly EventCampaignKind[] = ['invite', 'nudge'];

async function funnelFrom(
  store: DataStore,
  organizationId: string,
  campaigns: readonly CampaignSummary[],
  snapshot: GuestSnapshot,
  sessions: readonly EventSession[],
): Promise<Funnel> {
  const sentInvites = campaigns.filter(
    (c) => c.event_kind && FUNNEL_KINDS.includes(c.event_kind) && c.status !== 'draft',
  );
  const recipients = sentInvites.length
    ? await recipientsOfCampaigns(
        store,
        organizationId,
        sentInvites.map((c) => c.id),
      )
    : ok([]);
  return computeFunnel({
    guests: snapshot.guests,
    rows: snapshot.rows,
    sessions,
    recipients: recipients.ok ? recipients.value : [],
    viewed: snapshot.viewed,
  });
}

/* ---------------------------------------------------- needs notifying */

export interface NotifyQueueGroup {
  kind: NotifyKind;
  /** Status changes nobody has drafted a message for yet. */
  open: NotifyItem[];
  /** A live draft that already covers some: review and send it. */
  draft: { campaignId: string; count: number } | null;
}

const itemKey = (i: Pick<NotifyItem, 'guestId' | 'sessionId' | 'status'>) =>
  `${i.guestId}|${i.sessionId}|${i.status}`;

/** WS4's queue, grouped one message per kind, minus what an unsent draft already covers. */
export async function notifyQueue(
  store: DataStore,
  organizationId: string,
  eventId: string,
  campaigns: readonly CampaignSummary[],
): Promise<Result<NotifyQueueGroup[]>> {
  const groups = await needsNotifying(store, organizationId, eventId);
  if (!groups.ok) return groups;
  const drafts = campaigns.filter((c) => c.event_kind === 'notice' && c.status === 'draft');
  return ok(
    groups.value
      .map((group) => {
        const draft = drafts.find((c) => readMeta(c.event_meta).notifyKind === group.kind);
        const covered = new Set(
          (draft ? (readMeta(draft.event_meta).notify ?? []) : []).map(itemKey),
        );
        const open = group.items.filter((i) => !covered.has(itemKey(i)));
        return {
          kind: group.kind,
          open: open.map((i) => ({ ...i, email: null })),
          draft: draft ? { campaignId: draft.id, count: covered.size } : null,
        };
      })
      .filter((g) => g.open.length > 0 || g.draft),
  );
}

/**
 * Mark sent notices' status changes as told. Runs when the event's messages
 * are read: for each notice campaign that has left draft, the guests it
 * actually reached (recipient status 'sent') are passed to WS4's markNotified;
 * once the campaign is finished it is not looked at again. Never throws.
 */
export async function reconcileNotices(
  store: DataStore,
  organizationId: string,
  eventId: string,
  campaigns: readonly CampaignSummary[],
  now: Date = new Date(),
): Promise<number> {
  const due = campaigns.filter(
    (c) =>
      c.event_kind === 'notice' && c.status !== 'draft' && !readMeta(c.event_meta).reconciledAt,
  );
  if (!due.length) return 0;
  let marked = 0;
  try {
    const recipients = await recipientsOfCampaigns(
      store,
      organizationId,
      due.map((c) => c.id),
    );
    if (!recipients.ok) return 0;
    for (const campaign of due) {
      const meta = readMeta(campaign.event_meta);
      const reached = new Set(
        recipients.value
          .filter((r) => r.campaign_id === campaign.id && r.status === 'sent')
          .map((r) => r.email.toLowerCase()),
      );
      const items = (meta.notify ?? []).filter((i) => i.email && reached.has(i.email));
      if (items.length) {
        const result = await markNotified(
          store,
          organizationId,
          eventId,
          items.map(({ guestId, sessionId, status }) => ({ guestId, sessionId, status })),
        );
        if (result.ok) marked += result.value.updated;
      }
      if (campaign.status === 'sent' || campaign.status === 'cancelled') {
        await setEventCampaignMeta(store, organizationId, campaign.id, {
          ...(campaign.event_meta ?? {}),
          reconciledAt: now.toISOString(),
        });
        await recordAudit(store, {
          organizationId,
          userId: null,
          action: 'event.notified_marked',
          entityType: 'event',
          entityId: eventId,
          metadata: { campaign: campaign.id, items: items.length },
        });
      }
    }
  } catch (error) {
    log.warn('Event notice bookkeeping failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return marked;
}

/* ---------------------------------------------------------- the draft */

export interface DraftMessageResult {
  campaignId: string;
  name: string;
  /** Recipients on the draft. */
  added: number;
  /** Named by the audience but not added, and why (the campaign rules decide). */
  left: { unsubscribed: number; noEmail: number; invalid: number; overLimit: number };
  /** The page is not published yet: its links would not open until it is. */
  notLive: boolean;
}

/**
 * Draft one event message (POST /api/events/[id]/campaign). Returns the new
 * campaign's id; the page then opens it in the campaign review, where a
 * person reads it and taps Send. Sends nothing.
 */
export async function draftEventMessage(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  body: unknown,
  options: { appUrl: string; now?: Date },
): Promise<Result<DraftMessageResult>> {
  const parsed = eventMessageRequest.safeParse(body);
  if (!parsed.success) {
    return err('invalid_input', 'That message could not be read.', {
      details: { issue: parsed.error.issues[0]?.message ?? 'invalid' },
    });
  }
  const req = parsed.data;
  const org = owner.organizationId;
  const found = await getEvent(store, org, eventId);
  if (!found.ok) return found;
  const event = found.value;
  if (event.is_template) {
    return err('invalid_input', 'A template has no guests. Make an event from it first.');
  }
  const sessionsRead = await getEventSessions(store, org, event.id);
  if (!sessionsRead.ok) return sessionsRead;
  const sessions = sessionsRead.value;
  const session = req.sessionId ? (sessions.find((s) => s.id === req.sessionId) ?? null) : null;
  if (req.sessionId && !session) {
    return err('invalid_input', 'That session is not part of this event.');
  }

  const campaigns = await listEventCampaigns(store, org, event.id);
  if (!campaigns.ok) return campaigns;

  const meta: EventCampaignMeta = {};
  let audience: EventAudience;
  switch (req.kind) {
    case 'invite':
      audience = req.audience ?? { kind: 'status', statuses: ['invited'] };
      break;
    case 'reminder':
      if (!session || !req.offsetMinutes) {
        return err('invalid_input', 'Pick the session and how long before it the reminder goes.');
      }
      audience = { kind: 'status', statuses: ['going'], sessionId: session.id };
      meta.sessionId = session.id;
      meta.offsetMinutes = req.offsetMinutes;
      break;
    case 'notice': {
      if (!req.notifyKind) return err('invalid_input', 'Pick which status change to tell guests.');
      const queue = await notifyQueue(store, org, event.id, campaigns.value);
      if (!queue.ok) return queue;
      const items = queue.value.find((g) => g.kind === req.notifyKind)?.open ?? [];
      if (!items.length) {
        return err(
          'conflict',
          'Nobody is waiting to hear about that any more. Reload to see the queue.',
        );
      }
      audience = { kind: 'guests', guestIds: [...new Set(items.map((i) => i.guestId))] };
      meta.notifyKind = req.notifyKind;
      meta.notify = items;
      break;
    }
    case 'update':
      audience = req.audience ?? { kind: 'status', statuses: ['going'] };
      meta.scheduleVersion = event.schedule_version;
      break;
    case 'cancellation':
      audience = req.audience ?? {
        kind: 'status',
        statuses: ['going', 'maybe', 'pending', 'waitlist', 'invited'],
      };
      meta.scheduleVersion = event.schedule_version;
      break;
    case 'blast':
      if (!req.audience) return err('invalid_input', 'Pick who the message goes to.');
      audience = req.audience;
      break;
    case 'nudge': {
      if (!req.segment) return err('invalid_input', 'Pick who to nudge.');
      const snapshot = await readGuestSnapshot(store, org, event.id);
      const funnel = await funnelFrom(store, org, campaigns.value, snapshot, sessions);
      const ids =
        req.segment === 'never_opened'
          ? funnel.segments.neverOpened
          : funnel.segments.openedNoReply;
      if (!ids.length) return err('conflict', 'Nobody is in that group right now.');
      audience = { kind: 'guests', guestIds: ids };
      meta.segment = req.segment;
      break;
    }
  }
  meta.audience = audience;
  meta.audienceLabel = audienceLabel(audience, sessions);

  const members = await resolveAudience(store, org, event.id, audience);
  if (!members.ok) return members;
  if (meta.notify) {
    const emailOf = new Map(members.value.map((m) => [m.guestId, m.email.toLowerCase()]));
    meta.notify = meta.notify.map((i) => ({ ...i, email: emailOf.get(i.guestId) ?? null }));
  }

  const copy = messageCopy(req.kind, messageContext(event, sessions), {
    notifyKind: req.notifyKind,
    session: session
      ? {
          name: session.name,
          when: formatWhen(session.starts_at, session.ends_at, event.time_zone),
        }
      : null,
    offsetMinutes: req.offsetMinutes,
    segment: req.segment,
  });
  const created = await createCampaign(
    store,
    org,
    { userId: owner.userId },
    {
      name: copy.name,
      timeZone: event.time_zone,
      now: options.now,
      event: { eventId: event.id, kind: req.kind, meta },
    },
  );
  if (!created.ok) return created;
  const sender: CampaignFromIdentity = req.sender ?? event.comms?.sender ?? 'nick';
  const written = await updateCampaign(store, org, created.value.id, {
    subject: copy.subject,
    body_template: copy.body,
    from_identity: sender,
  });
  if (!written.ok) return written;

  const base = options.appUrl.replace(/\/+$/, '');
  const added = await addEventRecipients(
    store,
    org,
    created.value.id,
    members.value.map((m) => ({
      email: m.email,
      name: m.name ?? m.firstName,
      company: m.company,
      record_id: m.recordId,
      rsvpLink: `${base}${m.rsvpPath}`,
    })),
  );
  if (!added.ok) return added;

  await recordAudit(store, {
    organizationId: org,
    userId: owner.userId,
    action: 'event.campaign_drafted',
    entityType: 'event',
    entityId: event.id,
    metadata: { campaign: created.value.id, kind: req.kind, recipients: added.value.added },
  });
  return ok({
    campaignId: created.value.id,
    name: copy.name,
    added: added.value.added,
    left: {
      unsubscribed: added.value.unsubscribed,
      noEmail: added.value.noEmail,
      invalid: added.value.invalid.length,
      overLimit: added.value.overLimit,
    },
    notLive: event.status !== 'published',
  });
}

/* -------------------------------------------------------- the settings */

/**
 * The reminder schedule and the default sender (PUT …/campaign/settings).
 * Only events.comms changes; nothing is drafted or sent.
 */
export async function updateEventComms(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  input: { reminderOffsetsMinutes?: number[]; sender?: CampaignFromIdentity },
): Promise<Result<EventComms>> {
  const found = await getEvent(store, owner.organizationId, eventId);
  if (!found.ok) return found;
  const current: EventComms = found.value.comms ?? {
    reminder_offsets_minutes: [],
    sender: 'nick',
  };
  const next: EventComms = { ...current };
  if (input.reminderOffsetsMinutes !== undefined) {
    const offsets = cleanOffsets(input.reminderOffsetsMinutes);
    if (!offsets) {
      return err('invalid_input', 'Reminders go 1 minute to 60 days before, six at most.');
    }
    next.reminder_offsets_minutes = offsets;
  }
  if (input.sender !== undefined) {
    if (input.sender !== 'nick' && input.sender !== 'arwin') {
      return err('invalid_input', 'Choose Nick or Arwin.');
    }
    next.sender = input.sender;
  }
  try {
    await store.update('events', owner.organizationId, eventId, {
      comms: next,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    log.error('Saving event messages settings failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'That did not save. Try again.', { retryable: true });
  }
  await recordAudit(store, {
    organizationId: owner.organizationId,
    userId: owner.userId,
    action: 'event.settings_changed',
    entityType: 'event',
    entityId: eventId,
    metadata: { fields: ['comms'], reminders: next.reminder_offsets_minutes.length },
  });
  return ok(next);
}

/* ------------------------------------------------------------ the view */

export interface EventCampaignRow {
  id: string;
  name: string;
  kind: EventCampaignKind | null;
  status: CampaignSummary['status'];
  campaign: Pick<CampaignSummary, 'status' | 'pause_reason' | 'updated_at' | 'last_sent_at'>;
  createdAt: string;
  sentAt: string | null;
  audienceLabel: string | null;
  recipients: number;
  sent: number;
  opened: number;
  replied: number;
}

export interface AudienceOptions {
  all: number;
  statuses: { status: EventGuestStatus; count: number }[];
  tags: { tag: string; count: number }[];
  sessions: { id: string; name: string; count: number }[];
  checkedIn: number;
}

export interface EventMessagesView {
  /** Null when event messages are set up; else why not (the migration). */
  notSetUp: string | null;
  campaigns: EventCampaignRow[];
  queue: NotifyQueueGroup[];
  reminders: ReminderSlot[];
  remindersReady: number;
  funnel: Funnel;
  /** The time or place changed since the last update notice: who it would go to. */
  updateFor: number | null;
  /** The event is cancelled and no cancellation notice exists yet. */
  cancellationFor: number | null;
  audience: AudienceOptions;
  sender: CampaignFromIdentity;
  reminderOffsets: number[];
}

function campaignRow(c: CampaignSummary): EventCampaignRow {
  const meta = readMeta(c.event_meta);
  return {
    id: c.id,
    name: c.name,
    kind: c.event_kind ?? null,
    status: c.status,
    campaign: {
      status: c.status,
      pause_reason: c.pause_reason,
      updated_at: c.updated_at,
      last_sent_at: c.last_sent_at,
    },
    createdAt: c.created_at,
    sentAt: c.sent_at,
    audienceLabel: meta.audienceLabel ?? null,
    recipients: c.counts.total,
    sent: c.counts.sent,
    opened: c.counts.opened,
    replied: c.counts.replied,
  };
}

function audienceOptions(
  snapshot: GuestSnapshot,
  sessions: readonly EventSession[],
): AudienceOptions {
  const count = (audience: EventAudience) =>
    audienceGuestIds(snapshot.guests, snapshot.rows, audience).length;
  return {
    all: count({ kind: 'all' }),
    statuses: GUEST_STATUSES.map((status) => ({
      status,
      count: count({ kind: 'status', statuses: [status] }),
    })),
    tags: tagCounts(snapshot.guests.filter((g) => g.email)),
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      count: count({ kind: 'all', sessionId: s.id }),
    })),
    checkedIn: count({ kind: 'checked_in' }),
  };
}

/** Going guests (with an email) in the snapshot: who an update notice goes to. */
function goingCount(snapshot: GuestSnapshot): number {
  return audienceGuestIds(snapshot.guests, snapshot.rows, { kind: 'status', statuses: ['going'] })
    .length;
}

/** Whether a schedule change still needs its update notice, and how many it would reach. */
function pendingUpdate(
  event: EventRecord,
  campaigns: readonly CampaignSummary[],
  snapshot: GuestSnapshot,
): number | null {
  if (event.status !== 'published' || event.schedule_version <= 0) return null;
  const announced = campaigns.some(
    (c) =>
      (c.event_kind === 'update' || c.event_kind === 'cancellation') &&
      c.status !== 'cancelled' &&
      (readMeta(c.event_meta).scheduleVersion ?? -1) >= event.schedule_version,
  );
  if (announced) return null;
  const going = goingCount(snapshot);
  return going > 0 ? going : null;
}

function pendingCancellation(
  event: EventRecord,
  campaigns: readonly CampaignSummary[],
  snapshot: GuestSnapshot,
): number | null {
  if (event.status !== 'cancelled') return null;
  if (campaigns.some((c) => c.event_kind === 'cancellation' && c.status !== 'cancelled')) {
    return null;
  }
  const told = audienceGuestIds(snapshot.guests, snapshot.rows, {
    kind: 'status',
    statuses: ['going', 'maybe', 'pending', 'waitlist', 'invited'],
  }).length;
  return told > 0 ? told : null;
}

function reminderCampaigns(campaigns: readonly CampaignSummary[]) {
  return campaigns
    .filter((c) => c.event_kind === 'reminder')
    .map((c) => {
      const meta = readMeta(c.event_meta);
      return {
        id: c.id,
        status: c.status,
        sessionId: meta.sessionId ?? null,
        offsetMinutes: meta.offsetMinutes ?? null,
      };
    });
}

/** Whether reminders apply to an event at all: live, not cancelled or archived. */
function remindersApply(event: EventRecord): boolean {
  return event.status === 'published' && !event.is_template;
}

/**
 * Everything the Messages tab shows, read once. Marks sent notices first
 * (reconcileNotices), so the queue is current. Never throws.
 */
export async function eventMessagesView(
  store: DataStore,
  organizationId: string,
  event: EventRecord,
  sessions: readonly EventSession[],
  now: Date = new Date(),
): Promise<EventMessagesView> {
  const listed = await listEventCampaigns(store, organizationId, event.id);
  const notSetUp =
    !listed.ok && listed.error.code === 'not_configured' ? listed.error.message : null;
  const campaigns = listed.ok ? listed.value : [];
  await reconcileNotices(store, organizationId, event.id, campaigns, now);
  const snapshot = await readGuestSnapshot(store, organizationId, event.id);
  const queue = await notifyQueue(store, organizationId, event.id, campaigns);
  const offsets = event.comms?.reminder_offsets_minutes ?? [];
  const reminders = remindersApply(event)
    ? reminderSlots(sessions, offsets, reminderCampaigns(campaigns), now).filter(
        (s) => s.state !== 'missed',
      )
    : [];
  return {
    notSetUp,
    campaigns: campaigns.map(campaignRow),
    queue: queue.ok ? queue.value : [],
    reminders,
    remindersReady: reminders.filter((s) => reminderNeedsYou(s, now)).length,
    funnel: await funnelFrom(store, organizationId, campaigns, snapshot, sessions),
    updateFor: pendingUpdate(event, campaigns, snapshot),
    cancellationFor: pendingCancellation(event, campaigns, snapshot),
    audience: audienceOptions(snapshot, sessions),
    sender: event.comms?.sender ?? 'nick',
    reminderOffsets: offsets,
  };
}

/* --------------------------------------------- the summary Today reads */

export interface EventMessagesSummary {
  needsNotifying: number;
  remindersReady: number;
  updateFor: number | null;
  cancellationFor: number | null;
  invitesSent: number;
  invitesDrafted: number;
  newRegistrations: number;
  /** The reminders that want a person now, for Today and the alerts. */
  readyReminders: ReminderSlot[];
}

/** The counts Overview and Today need, without the full view. Never throws. */
export async function eventMessagesSummary(
  store: DataStore,
  organizationId: string,
  event: EventRecord,
  sessions: readonly EventSession[],
  now: Date = new Date(),
): Promise<EventMessagesSummary> {
  const listed = await listEventCampaigns(store, organizationId, event.id);
  const campaigns = listed.ok ? listed.value : [];
  await reconcileNotices(store, organizationId, event.id, campaigns, now);
  const [snapshot, queue] = await Promise.all([
    readGuestSnapshot(store, organizationId, event.id),
    notifyQueue(store, organizationId, event.id, campaigns),
  ]);
  const ready = remindersApply(event)
    ? reminderSlots(
        sessions,
        event.comms?.reminder_offsets_minutes ?? [],
        reminderCampaigns(campaigns),
        now,
      ).filter((s) => reminderNeedsYou(s, now))
    : [];
  const invites = campaigns.filter((c) => c.event_kind === 'invite');
  return {
    needsNotifying: queue.ok ? queue.value.reduce((sum, g) => sum + g.open.length, 0) : 0,
    remindersReady: ready.length,
    updateFor: pendingUpdate(event, campaigns, snapshot),
    cancellationFor: pendingCancellation(event, campaigns, snapshot),
    invitesSent: invites.filter((c) => c.status !== 'draft' && c.status !== 'cancelled').length,
    invitesDrafted: invites.filter((c) => c.status === 'draft').length,
    newRegistrations: snapshot.newSince(new Date(now.getTime() - 86_400_000)),
    readyReminders: ready,
  };
}

/** A reminder that wants sending, for the phone and desktop alerts. */
export interface DueEventReminder {
  eventId: string;
  title: string;
  slot: ReminderSlot;
}

/**
 * Every reminder across live events that is due now (or drafted and past its
 * time), for push-alerts.ts. Reads only; never throws.
 */
export async function dueEventReminders(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<DueEventReminder[]> {
  try {
    const events = await store.list('events', organizationId, { eq: { status: 'published' } });
    const soon = events.filter((e) => {
      if (e.is_template) return false;
      const start = e.starts_at ? Date.parse(e.starts_at) : NaN;
      const end = Date.parse(e.ends_at ?? e.starts_at ?? '');
      // Within the longest reminder window (60 days) and not over yet.
      return (
        Number.isFinite(start) && start - now.getTime() <= 86_400 * 60_000 && end > now.getTime()
      );
    });
    const out: DueEventReminder[] = [];
    for (const event of soon) {
      const sessions = await getEventSessions(store, organizationId, event.id);
      if (!sessions.ok) continue;
      const listed = await listEventCampaigns(store, organizationId, event.id);
      const campaigns = listed.ok ? listed.value : [];
      for (const slot of reminderSlots(
        sessions.value,
        event.comms?.reminder_offsets_minutes ?? [],
        reminderCampaigns(campaigns),
        now,
      )) {
        if (reminderNeedsYou(slot, now)) out.push({ eventId: event.id, title: event.title, slot });
      }
    }
    return out;
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Event reminder check failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}
