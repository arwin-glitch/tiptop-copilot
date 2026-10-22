import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { blockRegistry } from '@/lib/events/blocks';
import { ownerCapabilities, type EventCapabilities } from '@/lib/events/capabilities';
import {
  EVENT_SLUG_RE,
  RESERVED_EVENT_SLUGS,
  actorKey,
  actorOrganizationId,
  type CreateEventInput,
  type DraftSnapshot,
  type DraftSyncResult,
  type EventActor,
  type EventLibraryTab,
  type EventSummary,
  type PublishResult,
} from '@/lib/events/contracts';
import { newEventDoc } from '@/lib/events/doc';
import { enforceOpScope } from '@/lib/events/editor-auth';
import { applyOps } from '@/lib/events/merge';
import { draftOpsRequest, type DraftOpsResult, type OpConflict } from '@/lib/events/ops';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { getStarter } from '@/lib/events/starters';
import { getThemePreset } from '@/lib/events/themes';
import { recordAudit } from '@/lib/security/audit';
import { hashIp } from '@/lib/security/crypto';
import { log } from '@/lib/security/redact';
import { guestCounts } from '@/lib/services/event-guests';
import { eventMediaPublicUrl } from '@/lib/storage/provider';
import type {
  EventComms,
  EventEdit,
  EventRecord,
  EventRegistrationSettings,
  EventSession,
  EventVenue,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Events: the event row, its sessions and the draft document (D-075).
 *
 * The draft is edited op by op (lib/events/ops.ts) and merged per key
 * (lib/events/merge.ts) inside a compare-and-set on draft_version: read,
 * merge, `updateWhere draft_version = read version`, retry up to 3 times when
 * someone else's batch landed in between. Every applied op is logged in
 * event_edits (activity, conflict attribution, sync tombstones).
 *
 * Tables come from 20261023000000_events.sql, a hand-applied migration.
 * Until it runs every function returns `not_configured` with the fix, never
 * a throw, and the rest of Copilot is untouched.
 *
 * PART 2 (WS1, after the contract commit): updateEventSettings, syncDraft,
 * publish/unpublish/cancel/archive/delete/duplicate, versions and media.
 * Their signatures are final; their bodies return NOT_BUILT until then.
 */

export const EVENTS_MIGRATION_FILE = 'supabase/migrations/20261023000000_events.sql';
/** Compare-and-set attempts before a save gives up as "busy". */
export const DRAFT_CAS_ATTEMPTS = 3;

const NOT_SET_UP = `Events are not set up yet: the events tables do not exist. Run ${EVENTS_MIGRATION_FILE} in the Supabase SQL editor, then reload.`;

function notBuilt<T>(operation: string): Result<T> {
  return err('not_configured', 'This part of Events is still being built.', {
    stillUsable: 'Everything else in Copilot works as before.',
    details: { operation },
  });
}

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, {
        stillUsable: 'Everything else in Copilot works as before.',
        details: { operation },
      });
    }
    if (isUniqueViolation(error)) {
      return err('conflict', 'That link is already taken. Try another.', {
        details: { operation },
      });
    }
    log.error('Event operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Events could not be read just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '23505' || (typeof message === 'string' && /duplicate key value/i.test(message));
}

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

/* ------------------------------------------------------------------ reads */

export async function getEvent(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<EventRecord>> {
  return guard('getEvent', async () => {
    const event = await store.get('events', organizationId, eventId);
    return event ? ok(event) : err('not_found', 'That event does not exist.');
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
        ogImageUrl: e.og_image_path ? eventMediaPublicUrl(e.og_image_path) : null,
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
    const checked = parseEventDoc(doc, {
      validateProps: blockRegistry.validateProps,
      validateTheme: blockRegistry.validateTheme,
    });
    if (!checked.ok) {
      log.error('A starter produced an invalid event page', {
        starter: starter.id,
        issue: checked.issues[0] ?? '',
      });
      return err('internal', 'That starter could not be used just now.');
    }

    const sessionTimes = sessionsIn
      .flatMap((s) => [s.startsAt, s.endsAt])
      .filter((t): t is string => !!t);
    const startsAt = input.startsAt ?? (sessionTimes.length ? [...sessionTimes].sort()[0]! : null);
    const endsAt = input.endsAt ?? (sessionTimes.length ? [...sessionTimes].sort().at(-1)! : null);
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

    // Every event has at least one session: the ones given, else one that
    // matches the event itself.
    const sessions = (
      sessionsIn.length
        ? sessionsIn
        : [{ name: title.slice(0, 120), startsAt, endsAt, capacity: null }]
    ).map((s, position): EventSession => ({
      id: newId(),
      organization_id: owner.organizationId,
      event_id: id,
      name: s.name.trim().slice(0, 120),
      description: null,
      starts_at: s.startsAt ?? null,
      ends_at: s.endsAt ?? null,
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

/* ------------------------------------------------------------------ draft */

/** The capabilities an actor has on one event, or a refusal. */
function capabilitiesFor(actor: EventActor, eventId: string): Result<EventCapabilities> {
  if (actor.kind === 'owner') return ok(ownerCapabilities());
  // A grant is for one event only; anything else looks like nothing at all.
  if (actor.grant.eventId !== eventId) return err('not_found', 'That event does not exist.');
  return ok(actor.grant.capabilities);
}

function readDoc(event: EventRecord): Result<EventDoc> {
  const parsed = parseEventDoc(event.draft_doc);
  if (parsed.ok) return ok(parsed.value);
  log.error('A stored event page failed validation', {
    event: event.id,
    issue: parsed.issues[0] ?? '',
  });
  return err(
    'internal',
    'This event page could not be read. Restore an earlier version from History.',
  );
}

export async function getDraft(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<DraftSnapshot>> {
  const caps = capabilitiesFor(actor, eventId);
  if (!caps.ok) return caps;
  if (!caps.value.viewDraft) return err('not_found', 'That event does not exist.');
  return guard('getDraft', async () => {
    const event = await store.get('events', actorOrganizationId(actor), eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const doc = readDoc(event);
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
 * so routes pass it through as received.
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
  if (!caps.value.viewDraft) return err('not_found', 'That event does not exist.');
  const organizationId = actorOrganizationId(actor);

  return guard('applyDraftOps', async () => {
    for (let attempt = 1; attempt <= DRAFT_CAS_ATTEMPTS; attempt++) {
      const event = await store.get('events', organizationId, eventId);
      if (!event) return err('not_found', 'That event does not exist.');
      if (actor.kind === 'grant' && event.editing_paused) {
        return err('forbidden', 'Editing is paused. TipTop will reopen it when ready.');
      }
      const doc = readDoc(event);
      if (!doc.ok) return doc;

      const nextVersion = event.draft_version + 1;
      const merged = applyOps(doc.value, parsed.data.ops, {
        nextVersion,
        validateProps: blockRegistry.validateProps,
        validateTheme: blockRegistry.validateTheme,
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
          author_name: actor.name.slice(0, 120) || 'Someone',
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
}

/* ------------------------------------------------------- part 2 (stubs) */

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

export async function updateEventSettings(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  patch: EventSettingsPatch,
): Promise<Result<EventRecord>> {
  void store;
  void owner;
  void eventId;
  void patch;
  return notBuilt('updateEventSettings');
}

export async function syncDraft(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  since: number,
  presence: { focusedSectionId: string | null; typing: boolean } | null,
): Promise<Result<DraftSyncResult>> {
  void store;
  void actor;
  void eventId;
  void since;
  void presence;
  return notBuilt('syncDraft');
}

export async function publishEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  expectedDraftVersion: number,
): Promise<Result<PublishResult>> {
  void store;
  void owner;
  void eventId;
  void expectedDraftVersion;
  return notBuilt('publishEvent');
}

export async function unpublishEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<EventRecord>> {
  void store;
  void owner;
  void eventId;
  return notBuilt('unpublishEvent');
}

export async function cancelEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  message: string | null,
): Promise<Result<EventRecord>> {
  void store;
  void owner;
  void eventId;
  void message;
  return notBuilt('cancelEvent');
}

export async function archiveEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<EventRecord>> {
  void store;
  void owner;
  void eventId;
  return notBuilt('archiveEvent');
}

/** Drafts only: a published or past event is archived, never deleted. */
export async function deleteEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
): Promise<Result<true>> {
  void store;
  void owner;
  void eventId;
  return notBuilt('deleteEvent');
}

/** "Duplicate" and "Duplicate as next year": a new draft, times shifted by shiftDays. */
export async function duplicateEvent(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  options: { shiftDays: number; title?: string; asTemplate?: boolean },
): Promise<Result<EventRecord>> {
  void store;
  void owner;
  void eventId;
  void options;
  return notBuilt('duplicateEvent');
}
