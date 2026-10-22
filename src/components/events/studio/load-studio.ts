import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { ownerCapabilities } from '@/lib/events/capabilities';
import {
  actorKey,
  eventPaths,
  PUBLIC_VIEWER,
  type EventActor,
  type EventGrant,
  type EventPublicFacts,
  type EventSessionPublic,
  type EventVenuePublic,
} from '@/lib/events/contracts';
import { outsiderEndpoints, ownerEndpoints } from '@/lib/events/editor/api';
import { DEFAULT_PREVIEW_TAGS, type PreviewGuest } from '@/lib/events/editor/preview';
import type { StudioMediaItem } from '@/lib/events/editor/publish';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { presenceColor } from '@/lib/services/event-presence';
import { listMedia, resolveMedia } from '@/lib/services/event-media';
import { getDraft } from '@/lib/services/events';
import { eventMediaPublicUrl } from '@/lib/storage/provider';
import type { EventGuestSession, EventRecord, EventSession, EventVenue } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import type { StudioBootstrap } from './studio-types';

/**
 * Builds a Studio's bootstrap on the server, for an owner (signed in) or an
 * outside link (re-checked grant). Outsiders get only what designing the
 * page needs: the draft, public facts (the venue address only where it is
 * public anyway), media of this event, and their capabilities. Never guest
 * names, the published snapshot, settings or activity.
 */

function venuePublic(venue: EventVenue | null, full: boolean): EventVenuePublic | null {
  if (!venue) return null;
  const open = full || venue.reveal === 'public';
  return {
    kind: venue.kind,
    name: venue.name,
    address: open ? venue.address : null,
    lat: open ? venue.lat : null,
    lng: open ? venue.lng : null,
    mapsUrl: open ? venue.maps_url : null,
    onlineUrl: open ? venue.online_url : null,
    notes: venue.notes,
    revealRule: venue.reveal,
    revealed: open,
  };
}

/** The settings-derived facts the page shows, as Studio previews them. */
export function studioFacts(
  event: EventRecord,
  sessions: readonly EventSession[],
  options: { fullVenue: boolean },
): EventPublicFacts {
  const sessionFacts: EventSessionPublic[] = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    venue: s.venue ? venuePublic(s.venue, options.fullVenue) : null,
    remaining: null,
    full: false,
    waitlistOpen: s.waitlist ?? event.registration.waitlist,
    requiresApproval: s.requires_approval ?? event.access === 'approval',
  }));
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    status: event.status,
    visibility: event.visibility,
    timeZone: event.time_zone,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    venue: venuePublic(event.venue, options.fullVenue),
    sessions: sessionFacts,
    access: event.access,
    registrationOpen: event.registration.open,
    closesAt: event.registration.closes_at,
    cancelled: event.cancelled_at ? { message: event.cancel_message } : null,
    scheduleVersion: event.schedule_version,
    publishedVersion: event.published_version,
    ogImageUrl: event.og_image_path ? eventMediaPublicUrl(event.og_image_path) : null,
    path: eventPaths.page(event.slug),
  };
}

async function mediaFor(
  store: DataStore,
  actor: EventActor,
  event: EventRecord,
  doc: EventDoc,
): Promise<Pick<StudioBootstrap, 'media' | 'mediaItems' | 'mediaNote'>> {
  const [listed, resolved] = await Promise.all([
    listMedia(store, actor, event.id).catch(() => null),
    resolveMedia(store, event.organization_id, event.id, doc, {
      ...PUBLIC_VIEWER,
      kind: actor.kind === 'owner' ? 'owner' : 'editor',
    }).catch(() => null),
  ]);
  const media = resolved?.ok ? resolved.value : {};
  const rows = listed?.ok ? listed.value : [];
  const mediaItems: StudioMediaItem[] = rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    status: m.status,
    alt: m.alt,
    decorative: m.decorative,
    name: m.original_name,
    colors: m.colors,
    previewUrl: media[m.id]?.src ?? null,
  }));
  return {
    media,
    mediaItems,
    mediaNote: listed && !listed.ok ? listed.error.message : null,
  };
}

async function previewGuests(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<{ guests: PreviewGuest[]; tags: string[] }> {
  try {
    const [rows, statuses] = await Promise.all([
      store.list(
        'event_guests',
        organizationId,
        { eq: { event_id: eventId }, isNull: ['parent_guest_id'] },
        { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: 200 },
      ),
      store.list(
        'event_guest_sessions',
        organizationId,
        { eq: { event_id: eventId } },
        { limit: 2000 },
      ),
    ]);
    const byGuest = new Map<string, EventGuestSession[]>();
    for (const s of statuses) byGuest.set(s.guest_id, [...(byGuest.get(s.guest_id) ?? []), s]);
    const guests = rows.map((g): PreviewGuest => {
      const mine = byGuest.get(g.id) ?? [];
      const name = [g.first_name, g.last_name].filter(Boolean).join(' ') || null;
      return {
        id: g.id,
        firstName: g.first_name,
        name,
        company: g.company,
        tags: g.tags,
        // Registered = a place the host granted (Going or Maybe); a pending
        // request or the waitlist doesn't qualify (lib/events/visibility.ts).
        registered: mine.some((s) => s.status === 'going' || s.status === 'maybe'),
        going: mine.some((s) => s.status === 'going'),
      };
    });
    const tags = [...new Set(rows.flatMap((g) => g.tags))].slice(0, 30);
    return { guests, tags };
  } catch {
    return { guests: [], tags: [] };
  }
}

function docTags(doc: EventDoc): string[] {
  return [
    ...new Set(
      doc.sections.flatMap((s) => (s.visibility.mode === 'tags' ? s.visibility.tags : [])),
    ),
  ];
}

async function sessionsOf(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<EventSession[]> {
  return store
    .list(
      'event_sessions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    )
    .catch(() => []);
}

/** A signed-in owner's Studio. */
export async function loadOwnerStudio(
  store: DataStore,
  owner: { userId: string; organizationId: string; name: string },
  eventId: string,
): Promise<Result<StudioBootstrap>> {
  const actor: EventActor = { kind: 'owner', ...owner };
  const draft = await getDraft(store, actor, eventId);
  if (!draft.ok) return draft;
  const event = await store.get('events', owner.organizationId, eventId);
  if (!event) return err('not_found', 'That event does not exist.');
  const [sessions, media, people] = await Promise.all([
    sessionsOf(store, owner.organizationId, eventId),
    mediaFor(store, actor, event, draft.value.doc),
    previewGuests(store, owner.organizationId, eventId),
  ]);
  const published = event.published_doc ? parseEventDoc(event.published_doc) : null;
  const key = actorKey(actor);
  return ok({
    eventId,
    title: event.title,
    slug: event.slug,
    status: event.status,
    timeZone: event.time_zone,
    facts: studioFacts(event, sessions, { fullVenue: true }),
    doc: draft.value.doc,
    version: draft.value.version,
    publishedDoc: published?.ok ? published.value : null,
    publishedVersion: event.published_version,
    publishedDraftVersion: event.published_draft_version,
    publishedAt: event.published_at,
    editingPaused: event.editing_paused,
    registrationOpen: event.registration.open,
    ...media,
    actor: {
      key,
      name: owner.name,
      color: presenceColor(key),
      owner: true,
      outside: false,
      role: 'owner',
    },
    capabilities: ownerCapabilities(),
    guests: people.guests,
    tags: [...new Set([...DEFAULT_PREVIEW_TAGS, ...people.tags, ...docTags(draft.value.doc)])],
    endpoints: ownerEndpoints(eventId),
    backHref: eventPaths.detail(eventId, 'page'),
    shareHref: eventPaths.detail(eventId, 'sharing'),
  });
}

/** An outside editor's (or viewer link's) Studio: the grant is already re-checked. */
export async function loadOutsiderStudio(
  store: DataStore,
  grant: EventGrant,
): Promise<Result<StudioBootstrap>> {
  const actor: EventActor = { kind: 'grant', grant, name: grant.label };
  const draft = await getDraft(store, actor, grant.eventId);
  if (!draft.ok) return draft;
  const event = await store.get('events', grant.organizationId, grant.eventId);
  if (!event) return err('not_found', 'This link is not valid.');
  const [sessions, media] = await Promise.all([
    sessionsOf(store, grant.organizationId, grant.eventId),
    mediaFor(store, actor, event, draft.value.doc),
  ]);
  const key = actorKey(actor);
  return ok({
    eventId: event.id,
    title: event.title,
    slug: event.slug,
    status: event.status,
    timeZone: event.time_zone,
    facts: studioFacts(event, sessions, { fullVenue: false }),
    doc: draft.value.doc,
    version: draft.value.version,
    publishedDoc: null,
    publishedVersion: event.published_version,
    publishedDraftVersion: event.published_draft_version,
    publishedAt: event.published_at,
    editingPaused: event.editing_paused,
    registrationOpen: event.registration.open,
    ...media,
    actor: {
      key,
      name: grant.label,
      color: presenceColor(key),
      owner: false,
      outside: true,
      role: grant.role === 'viewer' ? 'viewer' : 'editor',
    },
    capabilities: grant.capabilities,
    guests: [],
    tags: [...new Set([...DEFAULT_PREVIEW_TAGS, ...docTags(draft.value.doc)])],
    endpoints: outsiderEndpoints(event.id),
    backHref: null,
    shareHref: null,
  });
}
