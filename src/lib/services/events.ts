import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import { blockRegistry } from '@/lib/events/blocks';
import { blockingProblems, readyChecklist } from '@/lib/events/checklist';
import {
  EVENT_SLUG_RE,
  PUBLIC_VIEWER,
  RESERVED_EVENT_SLUGS,
  actorKey,
  actorOrganizationId,
  eventPaths,
  type CreateEventInput,
  type DraftSnapshot,
  type DraftSyncResult,
  type EventActor,
  type EventLibraryTab,
  type EventPublicFacts,
  type EventSessionPublic,
  type EventSummary,
  type EventVenuePublic,
  type PresenceEntry,
  type PublishPreview,
  type PublishResult,
} from '@/lib/events/contracts';
import { shiftDays } from '@/lib/events/dates';
import { describeDiff, diffDocs } from '@/lib/events/diff';
import { newEventDoc, placeSection } from '@/lib/events/doc';
import { enforceOpScope } from '@/lib/events/editor-auth';
import { applyOps, changesSince } from '@/lib/events/merge';
import { renderOgImage } from '@/lib/events/og';
import { draftOpsRequest, type DraftOpsResult, type OpConflict } from '@/lib/events/ops';
import { parseEventDoc, type EventDoc, type ParseOptions } from '@/lib/events/schema';
import { getStarter } from '@/lib/events/starters';
import { getThemePreset } from '@/lib/events/themes';
import { filterDocForViewer } from '@/lib/events/visibility';
import { recordAudit } from '@/lib/security/audit';
import { hashIp } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import { guestCounts } from '@/lib/services/event-guests';
import { absoluteUrl, getEventStorage } from '@/lib/storage/event-storage';
import type {
  EventComms,
  EventEdit,
  EventMedia,
  EventPresence,
  EventQuestion,
  EventRecord,
  EventRegistrationSettings,
  EventSession,
  EventVenue,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import {
  EVENTS_MIGRATION_FILE,
  capabilitiesFor,
  cleanText,
  guard,
  notFound,
  readStoredDoc,
} from './event-access';
import { mediaIdsIn, removeEventMediaObjects, resolveMedia } from './event-media';
import {
  authorsSince,
  checkpointQuietly,
  diffLabels,
  describeChanges,
  insertVersion,
  pruneEdits,
} from './event-versions';

/**
 * Events: the event row, its sessions and the draft document (D-075).
 *
 * The draft is edited op by op (lib/events/ops.ts) and merged per key
 * (lib/events/merge.ts) inside a compare-and-set on draft_version: read,
 * merge, `updateWhere draft_version = read version`, retry up to 3 times when
 * someone else's batch landed in between. Every applied op is logged in
 * event_edits (activity, conflict attribution, sync tombstones).
 *
 * Publishing copies the draft into published_doc (what guests see), renders
 * the share card (WS2's renderOgImage) to event-media/og/<event>/v<n>.png and
 * saves a 'published' version. Settings (date, venue, registration) live on
 * the row and are live as soon as they are saved; the page document is live
 * only through Publish.
 *
 * Tables come from 20261023000000_events.sql, a hand-applied migration.
 * Until it runs every function returns `not_configured` with the fix, never
 * a throw, and the rest of Copilot is untouched.
 */

export { EVENTS_MIGRATION_FILE };
/** Compare-and-set attempts before a save gives up as "busy". */
export const DRAFT_CAS_ATTEMPTS = 3;

const REGISTRY_CHECKS: ParseOptions = {
  validateProps: blockRegistry.validateProps,
  validateTheme: blockRegistry.validateTheme,
};

/* ------------------------------------------------------------------ slugs */

/** A URL slug from a title: "Annual Meeting 2027!" → "annual-meeting-2027". */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return base || 'event';
}

/** Why a slug cannot be used, or null. */
export function slugProblem(slug: string): string | null {
  if (!EVENT_SLUG_RE.test(slug)) {
    return 'Links use lowercase letters, numbers and dashes (up to 50), starting and ending with a letter or number.';
  }
  if ((RESERVED_EVENT_SLUGS as readonly string[]).includes(slug)) return 'That word is reserved.';
  return null;
}

async function slugInUse(store: DataStore, organizationId: string, slug: string): Promise<boolean> {
  const [event, alias] = await Promise.all([
    store.findOne('events', organizationId, { eq: { slug } }),
    store.findOne('event_slug_aliases', organizationId, { eq: { slug } }),
  ]);
  return Boolean(event || alias);
}

/** The slug itself when free, else slug-2, slug-3 … */
async function freeSlug(
  store: DataStore,
  organizationId: string,
  base: string,
): Promise<string | null> {
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, 50 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (slugProblem(candidate)) continue;
    if (!(await slugInUse(store, organizationId, candidate))) return candidate;
  }
  return null;
}

/**
 * The event a slug names: its current slug, or an old one (an alias), which
 * the public route answers with a 301 to `redirectTo`. Aliases are permanent
 * and never taken by another event.
 */
export async function resolveSlug(
  store: DataStore,
  organizationId: string,
  slug: string,
): Promise<Result<{ event: EventRecord; redirectTo: string | null }>> {
  if (!EVENT_SLUG_RE.test(slug)) return notFound();
  return guard('resolveSlug', async () => {
    const event = await store.findOne('events', organizationId, { eq: { slug } });
    if (event) return ok({ event, redirectTo: null });
    const alias = await store.findOne('event_slug_aliases', organizationId, { eq: { slug } });
    if (!alias) return notFound();
    const target = await store.get('events', organizationId, alias.event_id);
    if (!target) return notFound();
    return ok({ event: target, redirectTo: eventPaths.page(target.slug) });
  });
}

/* --------------------------------------------------------------- defaults */

export function defaultRegistration(): EventRegistrationSettings {
  return {
    open: true,
    closes_at: null,
    show_remaining: false,
    response_set: {
      maybe: false,
      labels: { going: 'Going', maybe: 'Maybe', not_going: "Can't go" },
    },
    plus_ones: { max: 0, per_session: false, collect_email: false, ask_questions: false },
    waitlist: true,
    auto_promote: false,
    claim_window_hours: null,
    request_invite: false,
    guest_wall: 'hidden',
  };
}

export function defaultVenue(): EventVenue {
  return {
    kind: 'in_person',
    name: null,
    address: null,
    lat: null,
    lng: null,
    place_id: null,
    maps_url: null,
    online_url: null,
    reveal: 'public',
    notes: null,
  };
}

export function defaultComms(): EventComms {
  return { reminder_offsets_minutes: [10_080, 1_440, 180], sender: 'nick' };
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function validIso(value: string | null | undefined): boolean {
  return value === null || value === undefined || !Number.isNaN(Date.parse(value));
}

function toIso(value: string | null): string | null {
  return value === null ? null : new Date(Date.parse(value)).toISOString();
}

/* ------------------------------------------------------------------ reads */

export async function getEvent(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<EventRecord>> {
  return guard('getEvent', async () => {
    const event = await store.get('events', organizationId, eventId);
    return event ? ok(event) : notFound();
  });
}

export async function getEventSessions(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<EventSession[]>> {
  return guard('getEventSessions', async () =>
    ok(
      await store.list(
        'event_sessions',
        organizationId,
        { eq: { event_id: eventId } },
        { orderBy: [{ field: 'position', direction: 'asc' }] },
      ),
    ),
  );
}

function swatchOf(event: EventRecord): EventSummary['swatch'] {
  const raw = (event.published_doc ?? event.draft_doc) as {
    theme?: { palette?: Record<string, unknown> };
  };
  const palette = raw?.theme?.palette;
  const pick = (k: string) => (typeof palette?.[k] === 'string' ? (palette[k] as string) : null);
  const bg = pick('bg');
  const accent = pick('accent');
  const text = pick('text');
  return bg && accent && text ? { bg, accent, text } : null;
}

/** Which library tab an event belongs on. */
export function libraryTab(event: EventRecord, now: Date = new Date()): EventLibraryTab {
  if (event.is_template) return 'templates';
  if (event.status === 'draft') return 'drafts';
  const end = event.ends_at ?? event.starts_at;
  if (event.status === 'archived' || (end && Date.parse(end) < now.getTime())) return 'past';
  return 'upcoming';
}

export async function listEvents(
  store: DataStore,
  organizationId: string,
  options: { tab?: EventLibraryTab; search?: string; now?: Date } = {},
): Promise<Result<EventSummary[]>> {
  return guard('listEvents', async () => {
    const rows = await store.list('events', organizationId, undefined, {
      orderBy: [{ field: 'starts_at', direction: 'asc' }],
      limit: 500,
    });
    const search = options.search?.trim().toLowerCase();
    const now = options.now ?? new Date();
    const chosen = rows.filter(
      (e) =>
        (!options.tab || libraryTab(e, now) === options.tab) &&
        (!search || e.title.toLowerCase().includes(search)),
    );
    // Past events read newest first; the others soonest first.
    if (options.tab === 'past') chosen.reverse();
    const counts = await guestCounts(
      store,
      organizationId,
      chosen.map((e) => e.id),
    );
    const storage = getEventStorage();
    return ok(
      chosen.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        status: e.status,
        visibility: e.visibility,
        access: e.access,
        timeZone: e.time_zone,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        publishedAt: e.published_at,
        isTemplate: e.is_template,
        ogImageUrl: e.og_image_path ? storage.publicUrl(e.og_image_path) : null,
        swatch: swatchOf(e),
        hasUnpublishedChanges:
          e.published_at === null || e.draft_version > e.published_draft_version,
        counts: counts[e.id]!,
      })),
    );
  });
}

/* ----------------------------------------------------------------- create */

export interface EventOwner {
  userId: string;
  organizationId: string;
  name: string;
}

export function ownerActor(owner: EventOwner): EventActor {
  return { kind: 'owner', ...owner };
}

export async function createEvent(
  store: DataStore,
  owner: EventOwner,
  input: CreateEventInput,
): Promise<Result<EventRecord>> {
  const title = input.title?.trim() ?? '';
  if (title.length < 1 || title.length > 140) {
    return err('invalid_input', 'Give the event a title (up to 140 characters).');
  }
  const timeZone = input.timeZone?.trim() || 'America/Chicago';
  if (!validTimeZone(timeZone)) return err('invalid_input', 'That time zone is not recognised.');
  if (!validIso(input.startsAt) || !validIso(input.endsAt)) {
    return err('invalid_input', 'The start or end time is not a valid date.');
  }
  if (input.slug !== undefined) {
    const problem = slugProblem(input.slug);
    if (problem) return err('invalid_input', problem);
  }
  const sessionsIn = (input.sessions ?? []).filter((s) => s.name?.trim());
  if (sessionsIn.length > 20) return err('invalid_input', 'An event has at most 20 sessions.');
  for (const s of sessionsIn) {
    if (s.name.trim().length > 120)
      return err('invalid_input', 'Session names are up to 120 characters.');
    if (!validIso(s.startsAt) || !validIso(s.endsAt)) {
      return err('invalid_input', 'A session time is not a valid date.');
    }
  }

  return guard('createEvent', async () => {
    const slug = input.slug
      ? (await slugInUse(store, owner.organizationId, input.slug))
        ? null
        : input.slug
      : await freeSlug(store, owner.organizationId, slugify(title));
    if (!slug) return err('conflict', 'That link is already taken. Try another.');

    const starter = getStarter(input.starterId);
    const preset = getThemePreset(input.themePresetId ?? starter.themePresetId);
    const doc = newEventDoc(preset.theme, starter.sections, newId);
    const checked = parseEventDoc(doc, REGISTRY_CHECKS);
    if (!checked.ok) {
      log.error('A starter produced an invalid event page', {
        starter: starter.id,
        issue: checked.issues[0] ?? '',
      });
      return err('internal', 'That starter could not be used just now.');
    }

    // The starter's sessions (AGM: Meeting + Reception) when the dialog gave
    // none, placed from the event's start; the dialog's own times win.
    const startMs = input.startsAt ? Date.parse(input.startsAt) : null;
    const fromStarter = !sessionsIn.length && starter.sessions.length;
    const plannedSessions = sessionsIn.length
      ? sessionsIn.map((s) => ({ ...s, capacity: s.capacity ?? null }))
      : fromStarter
        ? starter.sessions.map((s) => ({
            name: s.name,
            startsAt:
              startMs === null ? null : new Date(startMs + s.offsetMinutes * 60_000).toISOString(),
            endsAt:
              startMs === null
                ? null
                : new Date(startMs + (s.offsetMinutes + s.durationMinutes) * 60_000).toISOString(),
            capacity: s.capacity,
          }))
        : [];

    const sessionTimes = plannedSessions
      .flatMap((s) => [s.startsAt, s.endsAt])
      .filter((t): t is string => !!t)
      .map((t) => new Date(Date.parse(t)).toISOString());
    // The event spans its sessions: the starter's evening reception never
    // runs past the event's own end time.
    const span = (given: string | null, pick: 'first' | 'last'): string | null => {
      const all = [...sessionTimes, ...(given ? [given] : [])].sort();
      return all.length ? (pick === 'first' ? all[0]! : all.at(-1)!) : null;
    };
    const startsAt = span(toIso(input.startsAt ?? null), 'first');
    const endsAt = span(toIso(input.endsAt ?? null), 'last');
    const now = new Date().toISOString();
    const id = newId();
    const event: EventRecord = {
      id,
      organization_id: owner.organizationId,
      slug,
      title,
      status: 'draft',
      visibility: starter.visibility,
      access: starter.access,
      password_hash: null,
      time_zone: timeZone,
      starts_at: startsAt,
      ends_at: endsAt,
      venue: { ...defaultVenue(), ...(input.venue ?? {}) },
      capacity: null,
      registration: defaultRegistration(),
      questions: [],
      comms: defaultComms(),
      draft_doc: checked.value as unknown as Record<string, unknown>,
      draft_version: 0,
      published_doc: null,
      published_version: 0,
      published_draft_version: 0,
      published_at: null,
      published_by: null,
      schedule_version: 0,
      og_image_path: null,
      editing_paused: false,
      cancel_message: null,
      cancelled_at: null,
      is_template: false,
      created_by: owner.userId,
      created_at: now,
      updated_at: now,
    };
    await store.insert('events', event);

    // Every event has at least one session: the planned ones, else one that
    // matches the event itself.
    const sessions = (
      plannedSessions.length
        ? plannedSessions
        : [{ name: title.slice(0, 120), startsAt, endsAt, capacity: null }]
    ).map((s, position): EventSession => ({
      id: newId(),
      organization_id: owner.organizationId,
      event_id: id,
      name: s.name.trim().slice(0, 120),
      description: null,
      starts_at: toIso(s.startsAt ?? null),
      ends_at: toIso(s.endsAt ?? null),
      venue: null,
      capacity: s.capacity ?? null,
      requires_approval: null,
      waitlist: null,
      visible_to_tags: [],
      position,
      created_at: now,
      updated_at: now,
    }));
    await store.insertMany('event_sessions', sessions);

    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.created',
      entityType: 'event',
      entityId: id,
      metadata: { starter: starter.id, theme: preset.id, sessions: sessions.length },
    });
    return ok(event);
  });
}

/* --------------------------------------------------------------- settings */

export type EventSettingsPatch = Partial<
  Pick<
    EventRecord,
    | 'title'
    | 'slug'
    | 'visibility'
    | 'access'
    | 'time_zone'
    | 'starts_at'
    | 'ends_at'
    | 'venue'
    | 'capacity'
    | 'registration'
    | 'questions'
    | 'comms'
    | 'editing_paused'
  >
>;

const isoString = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid date.');
const plain = (max: number) => z.string().max(max);
const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'Links start with https:// or http://.');

const venueSchema = z.strictObject({
  kind: z.enum(['in_person', 'online', 'hybrid']),
  name: plain(200).nullable(),
  address: plain(400).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  place_id: plain(200).nullable(),
  maps_url: httpUrl.nullable(),
  online_url: httpUrl.nullable(),
  reveal: z.enum(['public', 'registered', 'going']),
  notes: plain(2000).nullable(),
});

const registrationSchema = z.strictObject({
  open: z.boolean(),
  closes_at: isoString.nullable(),
  show_remaining: z.boolean(),
  response_set: z.strictObject({
    maybe: z.boolean(),
    labels: z.strictObject({ going: plain(40), maybe: plain(40), not_going: plain(40) }),
  }),
  plus_ones: z.strictObject({
    max: z.number().int().min(0).max(10),
    per_session: z.boolean(),
    collect_email: z.boolean(),
    ask_questions: z.boolean(),
  }),
  waitlist: z.boolean(),
  auto_promote: z.boolean(),
  claim_window_hours: z.number().int().min(1).max(336).nullable(),
  request_invite: z.boolean(),
  guest_wall: z.enum(['hidden', 'count', 'going', 'public']),
});

const questionSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.enum([
    'short_text',
    'long_text',
    'single_choice',
    'multi_choice',
    'yes_no',
    'dietary',
    'company',
    'job_title',
    'linkedin',
    'url',
    'phone',
    'number',
    'terms',
  ]),
  label: z.string().min(1).max(200),
  help: plain(500).nullable(),
  required: z.boolean(),
  options: z.array(plain(100)).max(50),
  session_id: z.string().uuid().nullable(),
  ask_plus_ones: z.boolean(),
  position: z.number().int().min(0).max(1000),
  removed_at: isoString.nullable(),
});

const commsSchema = z.strictObject({
  reminder_offsets_minutes: z
    .array(
      z
        .number()
        .int()
        .min(5)
        .max(60 * 24 * 60),
    )
    .max(6),
  sender: z.enum(['nick', 'arwin']),
});

const VENUE_SCHEDULE_KEYS = ['kind', 'name', 'address', 'online_url', 'lat', 'lng'] as const;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'value'}: ${issue.message}` : 'invalid';
}

/**
 * Owners change the event's settings: title, slug, visibility, access, time
 * zone and times, venue, capacity, registration, questions, comms and the
 * outside editors' pause. Objects (venue, registration, comms) merge over
 * the current value and are then checked whole. A slug rename keeps the old
 * slug as a permanent alias once the event has ever been published (a link
 * that went out keeps working, and no other event can take it); time, zone
 * and venue changes bump schedule_version, the calendar file's SEQUENCE.
 */
export async function updateEventSettings(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  patch: EventSettingsPatch,
): Promise<Result<EventRecord>> {
  if (!patch || typeof patch !== 'object') return err('invalid_input', 'Nothing to change.');
  const organizationId = owner.organizationId;
  return guard('updateEventSettings', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const next: Partial<EventRecord> = {};
    const changed = new Set<string>();
    const set = <K extends keyof EventRecord>(key: K, value: EventRecord[K]) => {
      if (JSON.stringify(event[key]) === JSON.stringify(value)) return;
      next[key] = value;
      changed.add(key);
    };

    if (patch.title !== undefined) {
      const title = typeof patch.title === 'string' ? cleanText(patch.title, 200) : '';
      if (title.length < 1 || title.length > 140) {
        return err('invalid_input', 'Give the event a title (up to 140 characters).');
      }
      set('title', title);
    }
    if (patch.visibility !== undefined) {
      if (!['public', 'unlisted', 'private'].includes(patch.visibility)) {
        return err('invalid_input', 'Visibility is public, unlisted or private.');
      }
      set('visibility', patch.visibility);
    }
    if (patch.access !== undefined) {
      if (!['open', 'approval', 'invite_only'].includes(patch.access)) {
        return err('invalid_input', 'Access is open, approval or invite only.');
      }
      set('access', patch.access);
    }
    if (patch.time_zone !== undefined) {
      if (typeof patch.time_zone !== 'string' || !validTimeZone(patch.time_zone)) {
        return err('invalid_input', 'That time zone is not recognised.');
      }
      set('time_zone', patch.time_zone);
    }
    for (const key of ['starts_at', 'ends_at'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        return err('invalid_input', 'The start or end time is not a valid date.');
      }
      set(key, toIso(value));
    }
    const starts = next.starts_at !== undefined ? next.starts_at : event.starts_at;
    const ends = next.ends_at !== undefined ? next.ends_at : event.ends_at;
    if (starts && ends && Date.parse(ends) < Date.parse(starts)) {
      return err('invalid_input', 'The event ends before it starts.');
    }
    if (patch.capacity !== undefined) {
      const cap = patch.capacity;
      if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 100_000)) {
        return err('invalid_input', 'Capacity is a whole number up to 100,000, or none.');
      }
      set('capacity', cap);
    }
    if (patch.venue !== undefined) {
      const parsed = venueSchema.safeParse({ ...event.venue, ...(patch.venue ?? {}) });
      if (!parsed.success) {
        return err('invalid_input', `The venue could not be saved (${firstIssue(parsed.error)}).`);
      }
      set('venue', parsed.data);
    }
    if (patch.registration !== undefined) {
      const parsed = registrationSchema.safeParse({
        ...event.registration,
        ...(patch.registration ?? {}),
      });
      if (!parsed.success) {
        return err(
          'invalid_input',
          `Registration settings could not be saved (${firstIssue(parsed.error)}).`,
        );
      }
      set('registration', parsed.data);
    }
    if (patch.questions !== undefined) {
      const parsed = z.array(questionSchema).max(50).safeParse(patch.questions);
      if (!parsed.success) {
        return err(
          'invalid_input',
          `The questions could not be saved (${firstIssue(parsed.error)}).`,
        );
      }
      const sessionIds = new Set(
        (await store.list('event_sessions', organizationId, { eq: { event_id: eventId } })).map(
          (s) => s.id,
        ),
      );
      if (parsed.data.some((q) => q.session_id && !sessionIds.has(q.session_id))) {
        return err('invalid_input', 'A question names a session this event does not have.');
      }
      if (new Set(parsed.data.map((q) => q.id)).size !== parsed.data.length) {
        return err('invalid_input', 'Two questions share an id.');
      }
      set('questions', parsed.data as EventQuestion[]);
    }
    if (patch.comms !== undefined) {
      const parsed = commsSchema.safeParse({ ...event.comms, ...(patch.comms ?? {}) });
      if (!parsed.success) {
        return err(
          'invalid_input',
          `Message settings could not be saved (${firstIssue(parsed.error)}).`,
        );
      }
      set('comms', parsed.data);
    }
    if (patch.editing_paused !== undefined) {
      if (typeof patch.editing_paused !== 'boolean') {
        return err('invalid_input', 'Pause editing is on or off.');
      }
      set('editing_paused', patch.editing_paused);
    }

    let oldSlug: string | null = null;
    if (patch.slug !== undefined && patch.slug !== event.slug) {
      const slug = typeof patch.slug === 'string' ? patch.slug.trim() : '';
      const problem = slugProblem(slug);
      if (problem) return err('invalid_input', problem);
      const holder = await store.findOne('events', organizationId, { eq: { slug } });
      if (holder && holder.id !== eventId) {
        return err('conflict', 'That link is already taken. Try another.');
      }
      const alias = await store.findOne('event_slug_aliases', organizationId, { eq: { slug } });
      if (alias && alias.event_id !== eventId) {
        return err('conflict', 'That link was used by another event and stays reserved for it.');
      }
      // Taking back one of this event's own old slugs: it stops being an alias.
      if (alias) await store.removeWhere('event_slug_aliases', organizationId, { eq: { slug } });
      next.slug = slug;
      changed.add('slug');
      oldSlug = event.slug;
    }

    if (!changed.size) return ok(event);

    const venueMoved =
      next.venue !== undefined &&
      VENUE_SCHEDULE_KEYS.some((k) => event.venue[k] !== next.venue![k]);
    if (
      venueMoved ||
      changed.has('starts_at') ||
      changed.has('ends_at') ||
      changed.has('time_zone')
    ) {
      next.schedule_version = event.schedule_version + 1;
    }
    next.updated_at = new Date().toISOString();
    const updated = await store.update('events', organizationId, eventId, next);

    if (oldSlug && event.published_at) {
      const kept = await store.findOne('event_slug_aliases', organizationId, {
        eq: { slug: oldSlug },
      });
      if (!kept) {
        await store.insert('event_slug_aliases', {
          slug: oldSlug,
          organization_id: organizationId,
          event_id: eventId,
          created_at: new Date().toISOString(),
        });
      }
    }

    const audit = (action: Parameters<typeof recordAudit>[1]['action'], metadata = {}) =>
      recordAudit(store, {
        organizationId,
        userId: owner.userId,
        action,
        entityType: 'event',
        entityId: eventId,
        metadata,
      });
    if (oldSlug) await audit('event.slug_changed', { from: oldSlug, to: updated.slug });
    if (changed.has('editing_paused')) {
      await audit(updated.editing_paused ? 'event.editing_paused' : 'event.editing_resumed');
    }
    const registrationKeys = ['registration', 'questions', 'access', 'capacity'].filter((k) =>
      changed.has(k),
    );
    if (registrationKeys.length)
      await audit('event.registration_changed', { keys: registrationKeys });
    const otherKeys = [...changed].filter(
      (k) => k !== 'slug' && k !== 'editing_paused' && !registrationKeys.includes(k),
    );
    if (otherKeys.length) {
      await audit('event.settings_changed', {
        keys: otherKeys,
        scheduleVersion: updated.schedule_version,
      });
    }
    return ok(updated);
  });
}

/**
 * The ICS SEQUENCE moves on: WS4 calls this when a session's time or venue
 * changes (event-level changes bump it in updateEventSettings). Returns the
 * new schedule_version.
 */
export async function bumpScheduleVersion(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<number>> {
  return guard('bumpScheduleVersion', async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const event = await store.get('events', organizationId, eventId);
      if (!event) return notFound();
      const written = await store.updateWhere(
        'events',
        organizationId,
        { eq: { id: eventId, schedule_version: event.schedule_version } },
        { schedule_version: event.schedule_version + 1 },
      );
      if (written.length) return ok(event.schedule_version + 1);
    }
    return err('conflict', 'The schedule is being changed elsewhere. Try again.', {
      retryable: true,
    });
  });
}

/* ------------------------------------------------------------------ draft */

function readDraft(event: EventRecord): Result<EventDoc> {
  return readStoredDoc(event.draft_doc, { eventId: event.id, what: 'draft' });
}

export async function getDraft(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<DraftSnapshot>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return notFound();
  return guard('getDraft', async () => {
    const event = await store.get('events', actorOrganizationId(actor), eventId);
    if (!event) return notFound();
    const doc = readDraft(event);
    if (!doc.ok) return doc;
    return ok({
      doc: doc.value,
      version: event.draft_version,
      editingPaused: event.editing_paused,
      publishedVersion: event.published_version,
      publishedDraftVersion: event.published_draft_version,
    });
  });
}

/** Fill in who made the change each conflict lost to, from event_edits. */
async function attributeConflicts(
  store: DataStore,
  organizationId: string,
  eventId: string,
  conflicts: OpConflict[],
): Promise<OpConflict[]> {
  const needs = conflicts.filter(
    (c) =>
      c.by === null &&
      (c.kind === 'key_changed' || c.kind === 'section_deleted' || c.kind === 'section_changed'),
  );
  if (!needs.length) return conflicts;
  const edits = await store.list(
    'event_edits',
    organizationId,
    { eq: { event_id: eventId } },
    { orderBy: [{ field: 'draft_version', direction: 'desc' }], limit: 200 },
  );
  const latest = (c: OpConflict): EventEdit | undefined =>
    edits.find((e) => {
      if (c.target === 'section' ? e.section_id !== c.sectionId : e.section_id !== null)
        return false;
      if (c.kind === 'section_deleted') return e.op === 'delete';
      if (c.target === 'theme' && e.op !== 'theme') return false;
      if (c.target === 'meta' && e.op !== 'page') return false;
      return c.keys.length === 0 || e.keys.some((k) => c.keys.includes(k));
    });
  return conflicts.map((c) => {
    const edit = needs.includes(c) ? latest(c) : undefined;
    return edit ? { ...c, by: { name: edit.author_name, actorKey: edit.actor_key } } : c;
  });
}

/**
 * Apply a batch of draft ops (POST …/draft/ops). The body is validated here,
 * so routes pass it through as received. Ops that conflict come back in
 * `conflicts` (the rest still apply); only losing the compare-and-set three
 * times in a row is an error (`conflict`, HTTP 409, retryable).
 */
export async function applyDraftOps(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  body: unknown,
  context: { ip?: string | null } = {},
): Promise<Result<DraftOpsResult>> {
  const parsed = draftOpsRequest.safeParse(body);
  if (!parsed.success) {
    return err('invalid_input', 'Those changes could not be read.', {
      details: { issue: parsed.error.issues[0]?.message ?? 'invalid' },
    });
  }
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return notFound();
  const organizationId = actorOrganizationId(actor);

  const result = await guard('applyDraftOps', async (): Promise<Result<DraftOpsResult>> => {
    for (let attempt = 1; attempt <= DRAFT_CAS_ATTEMPTS; attempt++) {
      const event = await store.get('events', organizationId, eventId);
      if (!event) return notFound();
      if (actor.kind === 'grant' && event.editing_paused) {
        return err('forbidden', 'Editing is paused. TipTop will reopen it when ready.');
      }
      const doc = readDraft(event);
      if (!doc.ok) return doc;

      const nextVersion = event.draft_version + 1;
      const merged = applyOps(doc.value, parsed.data.ops, {
        nextVersion,
        ...REGISTRY_CHECKS,
        authorize: enforceOpScope(caps.value, { isOwnerOnlyProp: blockRegistry.isOwnerOnlyProp }),
      });

      if (!merged.changed) {
        return ok({
          version: event.draft_version,
          applied: merged.applied,
          conflicts: await attributeConflicts(store, organizationId, eventId, merged.conflicts),
          changes: merged.changes,
        });
      }

      // The compare-and-set: only if nobody else's batch landed since the read.
      const written = await store.updateWhere(
        'events',
        organizationId,
        { eq: { id: eventId, draft_version: event.draft_version } },
        { draft_doc: merged.doc as unknown as Record<string, unknown>, draft_version: nextVersion },
      );
      if (written.length === 0) continue;

      const now = new Date().toISOString();
      const key = actorKey(actor);
      const ipHash = hashIp(context.ip ?? null);
      await store.insertMany(
        'event_edits',
        merged.edits.map((e): EventEdit => ({
          id: newId(),
          organization_id: organizationId,
          event_id: eventId,
          section_id: e.sectionId,
          op: e.op,
          keys: e.keys,
          before: e.before,
          after: e.after,
          draft_version: nextVersion,
          actor_key: key,
          author_name: cleanText(actor.name, 120) || 'Someone',
          ip_hash: ipHash,
          created_at: now,
        })),
      );
      return ok({
        version: nextVersion,
        applied: merged.applied,
        conflicts: await attributeConflicts(store, organizationId, eventId, merged.conflicts),
        changes: merged.changes,
      });
    }
    return err(
      'conflict',
      'Several people are saving at once. Your change is kept; it will retry.',
      {
        retryable: true,
      },
    );
  });
  // An autosave checkpoint every 5 minutes of activity (never fails the save).
  if (result.ok && result.value.applied.length) await checkpointQuietly(store, actor, eventId);
  return result;
}

/* ------------------------------------------------------------------- sync */

/** Presence rows older than this are ignored; the soft lock covers the last 20 s. */
export const PRESENCE_TTL_MS = 60_000;
export const PRESENCE_ACTIVE_MS = 20_000;
/** Edit-log rows one sync reads; more than this sends the whole doc instead. */
const SYNC_EDIT_LIMIT = 2000;

/** One colour per person, stable across polls (AA on white and on near-black). */
const PRESENCE_COLORS = [
  '#2B6D56',
  '#9A5B13',
  '#3559B7',
  '#A23B72',
  '#5B6B12',
  '#7A4FB5',
  '#B5482F',
  '#1E7A8C',
];

export function presenceColor(key: string): string {
  const n = Number.parseInt(sha256(key).slice(0, 8), 16);
  return PRESENCE_COLORS[n % PRESENCE_COLORS.length]!;
}

/**
 * Studio's poll (GET …/draft/sync?since=n, every 2 s while visible): what
 * changed after draft_version `since` (sections by their revs, deletions from
 * the edit log's tombstones, theme and page settings), the people in Studio,
 * and this caller's presence row upserted. The whole doc comes back instead
 * when `since` is older than the edit log reaches (pruned at 90 days) or
 * newer than the server's version.
 */
export async function syncDraft(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  since: number,
  presence: { focusedSectionId: string | null; typing: boolean } | null,
): Promise<Result<DraftSyncResult>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return notFound();
  if (!Number.isInteger(since) || since < -1) return err('invalid_input', 'Bad sync point.');
  const organizationId = actorOrganizationId(actor);
  const key = actorKey(actor);

  return guard('syncDraft', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const doc = readDraft(event);
    if (!doc.ok) return doc;
    const now = Date.now();

    if (presence) {
      const focused =
        presence.focusedSectionId &&
        doc.value.sections.some((s) => s.id === presence.focusedSectionId)
          ? presence.focusedSectionId
          : null;
      const row: EventPresence = {
        event_id: eventId,
        actor_key: key,
        organization_id: organizationId,
        name: cleanText(actor.name, 80) || 'Someone',
        color: presenceColor(key),
        focused_section_id: focused,
        typing: presence.typing === true,
        last_seen_at: new Date(now).toISOString(),
      };
      await store.upsert('event_presence', row, ['event_id', 'actor_key']);
    }

    const people = await store.list('event_presence', organizationId, {
      eq: { event_id: eventId },
      gte: { last_seen_at: new Date(now - PRESENCE_TTL_MS).toISOString() },
    });
    const others: PresenceEntry[] = people
      .filter((p) => p.actor_key !== key)
      .sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1))
      .map((p) => ({
        actorKey: p.actor_key,
        name: p.name,
        color: p.color,
        outside: p.actor_key.startsWith('g:'),
        focusedSectionId: p.focused_section_id,
        typing: p.typing,
        lastSeenAt: p.last_seen_at,
        active: now - Date.parse(p.last_seen_at) <= PRESENCE_ACTIVE_MS,
      }));

    const version = event.draft_version;
    const base = {
      version,
      presence: others,
      selfColor: presenceColor(key),
      editingPaused: event.editing_paused,
      publishedVersion: event.published_version,
    };
    const empty = { sections: [], deletedSectionIds: [], theme: null, meta: null };
    if (since === version) return ok({ ...base, full: null, changes: empty });

    let full = since < 0 || since > version;
    let tombstones: string[] = [];
    if (!full) {
      const edits = await store.list(
        'event_edits',
        organizationId,
        { eq: { event_id: eventId }, gt: { draft_version: since } },
        { orderBy: [{ field: 'draft_version', direction: 'asc' }], limit: SYNC_EDIT_LIMIT },
      );
      // The log must reach back to the first version after `since` (and a
      // truncated read cannot promise every tombstone).
      const oldest = edits[0]?.draft_version;
      full = oldest === undefined || oldest > since + 1 || edits.length >= SYNC_EDIT_LIMIT;
      const present = new Set(doc.value.sections.map((s) => s.id));
      tombstones = [
        ...new Set(
          edits
            .filter((e) => e.op === 'delete' && e.section_id && !present.has(e.section_id))
            .map((e) => e.section_id!),
        ),
      ];
    }
    if (full) return ok({ ...base, full: doc.value, changes: empty });
    return ok({
      ...base,
      full: null,
      changes: { ...changesSince(doc.value, since), deletedSectionIds: tombstones },
    });
  });
}

/* ---------------------------------------------------------------- publish */

function venueFor(venue: EventVenue | null, revealed: boolean): EventVenuePublic | null {
  if (!venue) return null;
  return {
    kind: venue.kind,
    name: venue.name,
    address: revealed ? venue.address : null,
    lat: revealed ? venue.lat : null,
    lng: revealed ? venue.lng : null,
    mapsUrl: revealed ? venue.maps_url : null,
    onlineUrl: revealed ? venue.online_url : null,
    notes: revealed ? venue.notes : null,
    revealRule: venue.reveal,
    revealed,
  };
}

/**
 * Facts for the PUBLIC share card: what any visitor may see (venue details
 * only when revealed to everyone, sessions without tag limits, no counts).
 */
function shareCardFacts(
  event: EventRecord,
  sessions: EventSession[],
  publishedVersion: number,
): EventPublicFacts {
  const venue = venueFor(event.venue, event.venue.reveal === 'public');
  const visible: EventSessionPublic[] = sessions
    .filter((s) => s.visible_to_tags.length === 0)
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      venue: s.venue ? venueFor(s.venue, s.venue.reveal === 'public') : null,
      remaining: null,
      full: false,
      waitlistOpen: false,
      requiresApproval: s.requires_approval ?? event.access === 'approval',
    }));
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    // The card shows the page as it will be once published.
    status: event.status === 'cancelled' ? 'cancelled' : 'published',
    visibility: event.visibility,
    timeZone: event.time_zone,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    venue,
    sessions: visible,
    access: event.access,
    registrationOpen: event.registration.open !== false,
    closesAt: event.registration.closes_at,
    cancelled: event.status === 'cancelled' ? { message: event.cancel_message } : null,
    scheduleVersion: event.schedule_version,
    publishedVersion,
    ogImageUrl: null,
    path: eventPaths.page(event.slug),
  };
}

/** Draw the share card (WS2's renderer) for the public view of a doc; null on any failure. */
async function drawShareCard(
  store: DataStore,
  event: EventRecord,
  sessions: EventSession[],
  doc: EventDoc,
  publishedVersion: number,
): Promise<Uint8Array | null> {
  try {
    const publicDoc = filterDocForViewer(doc, PUBLIC_VIEWER);
    const media = await resolveMedia(
      store,
      event.organization_id,
      event.id,
      publicDoc,
      PUBLIC_VIEWER,
      { absolute: true, excludeGated: true },
    );
    const png = await renderOgImage({
      doc: publicDoc,
      facts: shareCardFacts(event, sessions, publishedVersion),
      media: media.ok ? media.value : {},
      layout: doc.meta.ogLayout,
    });
    return png && png.byteLength > 0 ? png : null;
  } catch (error) {
    log.warn('The share card could not be drawn', {
      event: event.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function referencedMedia(
  store: DataStore,
  event: EventRecord,
  doc: EventDoc,
): Promise<EventMedia[]> {
  const ids = mediaIdsIn(doc);
  if (!ids.length) return [];
  return store.list('event_media', event.organization_id, {
    eq: { event_id: event.id },
    in: { id: ids },
  });
}

function blockLabel(type: Parameters<typeof diffLabels.block>[0]): string {
  return diffLabels.block(type);
}

/**
 * What Publish would change, with authors, and the Ready checklist (GET
 * …/publish). The share card is drawn as a trial so the checklist can say
 * whether it renders.
 */
export async function getPublishPreview(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<PublishPreview>> {
  const organizationId = owner.organizationId;
  return guard('getPublishPreview', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const draft = readStoredDoc(event.draft_doc, { eventId, what: 'draft' }, REGISTRY_CHECKS);
    if (!draft.ok) return draft;
    const published = event.published_doc
      ? readStoredDoc(event.published_doc, { eventId, what: 'published' })
      : null;
    const diff = diffDocs(published?.ok ? published.value : null, draft.value);
    const authors = await authorsSince(store, event);
    const lines = describeDiff(diff, diffLabels).map((l) => ({
      sectionId: l.sectionId,
      text: l.text,
      authors: authors.get(l.sectionId ?? l.kind) ?? [],
    }));
    const sessions = await store.list(
      'event_sessions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    );
    const og = await drawShareCard(
      store,
      event,
      sessions,
      draft.value,
      event.published_version + 1,
    );
    const checklist = readyChecklist({
      event,
      sessions,
      doc: draft.value,
      media: await referencedMedia(store, event, draft.value),
      ogRendered: og !== null,
      blockLabel,
    });
    return ok({
      draftVersion: event.draft_version,
      publishedVersion: event.published_version,
      neverPublished: event.published_at === null,
      lines,
      checklist,
      canPublish:
        blockingProblems(checklist).length === 0 &&
        !event.is_template &&
        event.status !== 'archived',
    });
  });
}

/**
 * Owners publish: the draft (validated whole, with the block registry's
 * strict checks) is copied into published_doc under a compare-and-set on the
 * draft_version the owner reviewed; the share card is stored at
 * og/<event>/v<n>.png (a new URL every version, so Slack and iMessage fetch
 * it again); a 'published' version is saved. Missing alt text blocks
 * publishing; every other checklist item only warns. A cancelled event stays
 * cancelled (its page refreshes, the notice stays).
 */
export async function publishEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  expectedDraftVersion: number,
): Promise<Result<PublishResult>> {
  if (!Number.isInteger(expectedDraftVersion) || expectedDraftVersion < 0) {
    return err('invalid_input', 'Reload the publish dialog and try again.');
  }
  const organizationId = owner.organizationId;
  return guard('publishEvent', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    if (event.is_template) return err('invalid_input', 'Templates are not published.');
    if (event.status === 'archived') {
      return err('invalid_input', 'This event is archived. Duplicate it to publish again.');
    }
    if (event.draft_version !== expectedDraftVersion) {
      return err('conflict', 'The page changed since you opened Publish. Review the new changes.', {
        details: { draftVersion: event.draft_version },
      });
    }
    const draft = readStoredDoc(event.draft_doc, { eventId, what: 'draft' }, REGISTRY_CHECKS);
    if (!draft.ok) {
      return err(
        'invalid_input',
        'The page has something that cannot be published. Open Studio to fix it.',
      );
    }
    const sessions = await store.list(
      'event_sessions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    );
    const checklist = readyChecklist({
      event,
      sessions,
      doc: draft.value,
      media: await referencedMedia(store, event, draft.value),
      ogRendered: null,
      blockLabel,
    });
    const blocking = blockingProblems(checklist);
    if (blocking.length) {
      return err(
        'invalid_input',
        blocking[0]!.detail ?? 'Something must be fixed before publishing.',
        {
          details: { check: blocking[0]!.id },
        },
      );
    }

    const publishedVersion = event.published_version + 1;
    const storage = getEventStorage();
    let ogPath: string | null = null;
    const png = await drawShareCard(store, event, sessions, draft.value, publishedVersion);
    if (png) {
      const path = `og/${eventId}/v${publishedVersion}.png`;
      const stored = await storage.put('public', path, png, 'image/png', { upsert: true });
      if (stored.ok) ogPath = path;
      else
        log.warn('The share card could not be stored', {
          event: eventId,
          reason: stored.error.code,
        });
    }

    const previous = event.published_doc
      ? readStoredDoc(event.published_doc, { eventId, what: 'published' })
      : null;
    const now = new Date().toISOString();
    const written = await store.updateWhere(
      'events',
      organizationId,
      // The reviewed draft, and nobody unpublished, cancelled or archived meanwhile.
      { eq: { id: eventId, draft_version: expectedDraftVersion, status: event.status } },
      {
        published_doc: draft.value as unknown as Record<string, unknown>,
        published_version: publishedVersion,
        published_draft_version: expectedDraftVersion,
        published_at: now,
        published_by: owner.userId,
        status: event.status === 'cancelled' ? 'cancelled' : 'published',
        og_image_path: ogPath,
        updated_at: now,
      },
    );
    if (written.length === 0) {
      return err(
        'conflict',
        'The page changed while publishing. Review the new changes and publish again.',
      );
    }

    await insertVersion(store, {
      organizationId,
      eventId,
      kind: 'published',
      name: `Published v${publishedVersion}`,
      doc: draft.value,
      draftVersion: expectedDraftVersion,
      actor: ownerActor(owner),
    });
    const changes = describeChanges(diffDocs(previous?.ok ? previous.value : null, draft.value));
    await recordAudit(store, {
      organizationId,
      userId: owner.userId,
      action: 'event.published',
      entityType: 'event',
      entityId: eventId,
      metadata: {
        version: publishedVersion,
        draftVersion: expectedDraftVersion,
        changes: changes.slice(0, 20),
        shareCard: ogPath !== null,
        warnings: checklist.filter((c) => !c.ok).map((c) => c.id),
      },
    });
    // Housekeeping while we are here: the edit log keeps 90 days.
    try {
      await pruneEdits(store, organizationId, eventId);
    } catch (error) {
      log.warn('Edit log pruning failed', {
        event: eventId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return ok({
      publishedVersion,
      path: eventPaths.page(event.slug),
      ogImageUrl: ogPath ? absoluteUrl(storage.publicUrl(ogPath)) : null,
    });
  });
}

async function setStatus(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  operation: string,
  decide: (event: EventRecord) => Result<Partial<EventRecord>>,
  audit: {
    action: Parameters<typeof recordAudit>[1]['action'];
    metadata?: (e: EventRecord) => Record<string, unknown>;
  },
): Promise<Result<EventRecord>> {
  const organizationId = owner.organizationId;
  return guard(operation, async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    const patch = decide(event);
    if (!patch.ok) return patch;
    const written = await store.updateWhere(
      'events',
      organizationId,
      { eq: { id: eventId, status: event.status } },
      { ...patch.value, updated_at: new Date().toISOString() },
    );
    if (!written.length)
      return err('conflict', 'Someone else just changed this event. Reload and try again.');
    await recordAudit(store, {
      organizationId,
      userId: owner.userId,
      action: audit.action,
      entityType: 'event',
      entityId: eventId,
      metadata: audit.metadata?.(event) ?? {},
    });
    return ok(written[0]!);
  });
}

/** The public URL answers 404 again; guests, the snapshot and versions are kept. */
export async function unpublishEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<EventRecord>> {
  return setStatus(
    store,
    owner,
    eventId,
    'unpublishEvent',
    (event) =>
      event.status === 'published' || event.status === 'cancelled'
        ? ok({ status: 'draft' })
        : err('invalid_input', 'This event is not published.'),
    { action: 'event.unpublished', metadata: (e) => ({ from: e.status }) },
  );
}

/**
 * The URL stays live as a themed "Cancelled" page with the host's message;
 * the calendar SEQUENCE moves on (the ICS says CANCELLED). Drafting the
 * cancellation notice is a campaign draft a person sends (WS5).
 */
export async function cancelEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  message: string | null,
): Promise<Result<EventRecord>> {
  const note = message === null || message === undefined ? null : cleanText(message, 2000) || null;
  return setStatus(
    store,
    owner,
    eventId,
    'cancelEvent',
    (event) => {
      if (event.status === 'cancelled')
        return err('invalid_input', 'This event is already cancelled.');
      if (event.status === 'archived') return err('invalid_input', 'This event is archived.');
      if (!event.published_doc) {
        return err(
          'invalid_input',
          'This event was never published, so there is no page to cancel. Delete the draft instead.',
        );
      }
      return ok({
        status: 'cancelled',
        cancel_message: note,
        cancelled_at: new Date().toISOString(),
        schedule_version: event.schedule_version + 1,
      });
    },
    { action: 'event.cancelled', metadata: () => ({ withMessage: note !== null }) },
  );
}

/** Off the public web and into Past; nothing is deleted. */
export async function archiveEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<EventRecord>> {
  return setStatus(
    store,
    owner,
    eventId,
    'archiveEvent',
    (event) =>
      event.status === 'archived'
        ? err('invalid_input', 'This event is already archived.')
        : ok({ status: 'archived' }),
    { action: 'event.archived', metadata: (e) => ({ from: e.status }) },
  );
}

/** Child tables, emptied explicitly (the demo store has no cascades). */
const EVENT_CHILD_TABLES = [
  'event_guest_sessions',
  'event_guests',
  'event_sessions',
  'event_editors',
  'event_presence',
  'event_versions',
  'event_edits',
  'event_media',
  'event_page_views',
  'event_share_links',
  'event_slug_aliases',
] as const;

/**
 * Drafts only: a never-published draft (or a template) with no guests. A
 * published or past event is archived, never deleted. Media objects go too,
 * except ones a duplicated event still shares.
 */
export async function deleteEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<true>> {
  const organizationId = owner.organizationId;
  return guard('deleteEvent', async () => {
    const event = await store.get('events', organizationId, eventId);
    if (!event) return notFound();
    if (!event.is_template && (event.status !== 'draft' || event.published_at !== null)) {
      return err(
        'invalid_input',
        'Only a draft that was never published can be deleted. Archive it instead.',
      );
    }
    const guests = await store.count('event_guests', organizationId, { eq: { event_id: eventId } });
    if (guests > 0) {
      return err(
        'invalid_input',
        `This draft has ${guests} guest${guests === 1 ? '' : 's'}. Remove them first, or archive the event.`,
      );
    }
    await removeEventMediaObjects(store, organizationId, eventId);
    for (const table of EVENT_CHILD_TABLES) {
      await store.removeWhere(table, organizationId, { eq: { event_id: eventId } });
    }
    await store.remove('events', organizationId, eventId);
    await recordAudit(store, {
      organizationId,
      userId: owner.userId,
      action: 'event.deleted',
      entityType: 'event',
      entityId: eventId,
      metadata: { slug: event.slug, template: event.is_template },
    });
    return ok(true);
  });
}

const MAX_SHIFT_DAYS = 3660;

/** Replace every media id in a JSON value (keys ending in mediaId) through `map`. */
function remapMediaIds(value: unknown, map: Map<string, string>, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => remapMediaIds(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        remapMediaIds(v, map, k),
      ]),
    );
  }
  if (typeof value === 'string' && /mediaId$/.test(key)) return map.get(value) ?? value;
  return value;
}

/**
 * "Duplicate" and "Duplicate as next year": a new draft with the page (new
 * section ids, revisions reset), theme, sessions, questions, tags and comms
 * settings, every date shifted by `shiftDays` keeping the wall-clock time in
 * the event's zone. Guests, versions, edit links and the share card are not
 * copied. Media rows the page uses are copied (sharing the stored files).
 * `asTemplate` saves it under Templates instead ("Save as template").
 */
export async function duplicateEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  options: { shiftDays: number; title?: string; asTemplate?: boolean },
): Promise<Result<EventRecord>> {
  const shift = options?.shiftDays ?? 0;
  if (!Number.isInteger(shift) || Math.abs(shift) > MAX_SHIFT_DAYS) {
    return err('invalid_input', 'Shift the dates by a whole number of days, up to ten years.');
  }
  const organizationId = owner.organizationId;
  return guard('duplicateEvent', async () => {
    const source = await store.get('events', organizationId, eventId);
    if (!source) return notFound();
    const sourceDoc = readDraft(source);
    if (!sourceDoc.ok) return sourceDoc;

    const asTemplate = options.asTemplate === true;
    const wanted = options.title ? cleanText(options.title, 140) : '';
    const title = (wanted || (asTemplate ? source.title : `${source.title} (copy)`)).slice(0, 140);
    const slug = await freeSlug(store, organizationId, slugify(title));
    if (!slug)
      return err('conflict', 'No free link could be made from that title. Try another title.');
    const tz = source.time_zone;
    const move = (iso: string | null) => shiftDays(iso, shift, tz);
    const now = new Date().toISOString();
    const id = newId();

    // Media the page uses: new rows for the new event, same stored objects.
    const mediaMap = new Map<string, string>();
    const sourceMedia = await referencedMedia(store, source, sourceDoc.value);
    const copiedMedia: EventMedia[] = sourceMedia.map((m) => {
      const newMediaId = newId();
      mediaMap.set(m.id, newMediaId);
      return {
        ...structuredClone(m),
        id: newMediaId,
        event_id: id,
        created_by_actor: `u:${owner.userId}`,
        created_at: now,
        updated_at: now,
      };
    });

    const remapped = remapMediaIds(sourceDoc.value, mediaMap) as EventDoc;
    const doc: EventDoc = {
      schemaVersion: remapped.schemaVersion,
      theme: { ...remapped.theme, rev: 0, keyRevs: {} },
      meta: { ...remapped.meta, rev: 0, keyRevs: {} },
      sections: remapped.sections.map((s) => {
        const { id: _old, position, rev: _rev, keyRevs: _revs, ...template } = s;
        return placeSection(template, newId(), position, 0);
      }),
    };
    const checked = parseEventDoc(doc);
    if (!checked.ok) return err('internal', 'That page could not be copied just now.');

    const sourceSessions = await store.list(
      'event_sessions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    );
    const sessionMap = new Map<string, string>();
    const sessions: EventSession[] = sourceSessions.map((s) => {
      const sid = newId();
      sessionMap.set(s.id, sid);
      return {
        ...structuredClone(s),
        id: sid,
        event_id: id,
        starts_at: move(s.starts_at),
        ends_at: move(s.ends_at),
        created_at: now,
        updated_at: now,
      };
    });
    const questions: EventQuestion[] = (source.questions ?? [])
      .filter((q) => !q.removed_at)
      .map((q) => ({
        ...structuredClone(q),
        id: newId(),
        session_id: q.session_id ? (sessionMap.get(q.session_id) ?? null) : null,
      }));

    const event: EventRecord = {
      ...structuredClone(source),
      id,
      slug,
      title,
      status: 'draft',
      password_hash: null,
      starts_at: move(source.starts_at),
      ends_at: move(source.ends_at),
      registration: {
        ...structuredClone(source.registration),
        closes_at: move(source.registration.closes_at ?? null),
      },
      questions,
      draft_doc: checked.value as unknown as Record<string, unknown>,
      draft_version: 0,
      published_doc: null,
      published_version: 0,
      published_draft_version: 0,
      published_at: null,
      published_by: null,
      schedule_version: 0,
      og_image_path: null,
      editing_paused: false,
      cancel_message: null,
      cancelled_at: null,
      is_template: asTemplate,
      created_by: owner.userId,
      created_at: now,
      updated_at: now,
    };
    await store.insert('events', event);
    if (sessions.length) await store.insertMany('event_sessions', sessions);
    else {
      await store.insert('event_sessions', {
        id: newId(),
        organization_id: organizationId,
        event_id: id,
        name: title.slice(0, 120),
        description: null,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        venue: null,
        capacity: null,
        requires_approval: null,
        waitlist: null,
        visible_to_tags: [],
        position: 0,
        created_at: now,
        updated_at: now,
      });
    }
    if (copiedMedia.length) await store.insertMany('event_media', copiedMedia);

    await recordAudit(store, {
      organizationId,
      userId: owner.userId,
      action: asTemplate ? 'event.template_saved' : 'event.duplicated',
      entityType: 'event',
      entityId: id,
      metadata: { from: eventId, shiftDays: shift, sessions: sessions.length },
    });
    return ok(event);
  });
}
