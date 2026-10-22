import type { EventVenuePublic, EventViewer } from '@/lib/events/contracts';
import type { EventDoc, EventSection, SectionVisibility } from '@/lib/events/schema';
import type {
  EventGuest,
  EventGuestSession,
  EventGuestStatus,
  EventSession,
  EventVenue,
  EventVenueReveal,
} from '@/lib/types/domain';

/**
 * Who may see what on an event page (D-075), decided on the SERVER before a
 * document reaches the renderer: a section, field or list item a viewer does
 * not qualify for is REMOVED from what is sent, never hidden with CSS. Studio's
 * "Preview as" runs the same functions with a sample viewer. Pure and
 * isomorphic.
 *
 * The rules (Everyone / Registered / Going / Tags / Hidden):
 *   - everyone:   anyone who can open the page.
 *   - registered: the viewer has asked for or been given a place in a
 *                 session (Going, Maybe, Pending or Waitlist).
 *   - going:      Going to at least one session.
 *   - tags:       the viewer carries one of the tags AND is in good standing
 *                 — invited, Maybe or Going somewhere. A waitlisted, pending,
 *                 declined or "can't go" guest never sees tag-gated details
 *                 (the spec: "Waitlisted guests never see gated details").
 *   - hidden:     nobody but owners and editor/viewer links.
 *
 * Owners, outside editors and viewer links see everything (they preview).
 *
 * FIELD- AND ITEM-LEVEL GATING (for WS2's blocks; generic over props):
 *   - props.fieldVisibility = { <propKey>: { mode, tags } } removes those
 *     props for viewers who do not qualify. The map itself is never sent to
 *     a guest.
 *   - Any object inside a props array with a `visibility: { mode, tags }`
 *     key is removed for viewers who do not qualify (a Materials item for
 *     LPs only, an agenda line for Going guests).
 *   - Any object inside a props array with a `sessionId` key is removed when
 *     that session is not visible to the viewer (agenda items tied to a
 *     session follow its tag visibility: Reception-only invitees never see
 *     the Meeting's items).
 *   - Venue sections lose their address-like props when the venue is not
 *     revealed to this viewer; blocks should render facts.venue, which the
 *     reveal rule has already been applied to.
 */

export const FIELD_VISIBILITY_PROP = 'fieldVisibility';
export const ITEM_VISIBILITY_KEY = 'visibility';
export const ITEM_SESSION_KEY = 'sessionId';
/** Props a venue section drops when the address is not revealed. */
export const VENUE_SECRET_PROPS = [
  'address',
  'mapsUrl',
  'mapUrl',
  'onlineUrl',
  'joinUrl',
  'lat',
  'lng',
  'placeId',
  'directions',
  'embed',
] as const;

const PRIVILEGED = new Set(['owner', 'editor', 'viewer']);

/** Statuses that mean "has a place or asked for one". */
const REGISTERED: ReadonlySet<EventGuestStatus> = new Set([
  'going',
  'maybe',
  'pending',
  'waitlist',
]);
/** Statuses that keep tag-gated details visible. */
const GOOD_STANDING: ReadonlySet<EventGuestStatus> = new Set(['going', 'maybe', 'invited']);

export function isPrivilegedViewer(viewer: EventViewer): boolean {
  return PRIVILEGED.has(viewer.kind);
}

/**
 * Invited, Maybe or Going somewhere. A viewer with no per-session statuses
 * known (rsvp null: a preview's sample guest) counts as in good standing; a
 * real guest with an empty map (on the list, no session rows yet) too.
 */
export function inGoodStanding(viewer: EventViewer): boolean {
  if (viewer.rsvp === null) return viewer.kind === 'guest';
  const statuses = Object.values(viewer.rsvp);
  if (!statuses.length) return viewer.kind === 'guest';
  return statuses.some((s) => GOOD_STANDING.has(s));
}

function hasAnyTag(viewer: EventViewer, tags: readonly string[]): boolean {
  if (!tags.length) return false;
  const mine = new Set(viewer.tags.map((t) => t.toLowerCase()));
  return tags.some((t) => mine.has(t.toLowerCase()));
}

/** Whether one visibility rule lets this viewer see the thing it guards. */
export function ruleAllows(rule: SectionVisibility, viewer: EventViewer): boolean {
  if (isPrivilegedViewer(viewer)) return true;
  switch (rule.mode) {
    case 'everyone':
      return true;
    case 'hidden':
      return false;
    case 'registered':
      return viewer.registered;
    case 'going':
      return viewer.going;
    case 'tags':
      return hasAnyTag(viewer, rule.tags) && inGoodStanding(viewer);
  }
}

/** Whether one section is shown to this viewer. */
export function sectionVisibleTo(section: EventSection, viewer: EventViewer): boolean {
  return ruleAllows(section.visibility, viewer);
}

function isRule(value: unknown): value is SectionVisibility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { mode?: unknown; tags?: unknown };
  return (
    typeof v.mode === 'string' &&
    ['everyone', 'registered', 'going', 'tags', 'hidden'].includes(v.mode) &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string')
  );
}

export interface FilterOptions {
  /** Sessions this viewer may see (items tied to others are removed). Omitted: keep all. */
  visibleSessionIds?: ReadonlySet<string>;
  /** Whether the venue's address is revealed to this viewer. Omitted: true. */
  venueRevealed?: boolean;
}

/** A gated (malformed) item is removed rather than shown: the safe failure. */
function filterValue(value: unknown, viewer: EventViewer, options: FilterOptions): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        if (ITEM_VISIBILITY_KEY in obj) {
          const rule = obj[ITEM_VISIBILITY_KEY];
          if (rule !== null && (!isRule(rule) || !ruleAllows(rule, viewer))) continue;
        }
        const session = obj[ITEM_SESSION_KEY];
        if (
          typeof session === 'string' &&
          session &&
          options.visibleSessionIds &&
          !options.visibleSessionIds.has(session)
        ) {
          continue;
        }
      }
      out.push(filterValue(item, viewer, options));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = filterValue(v, viewer, options);
    }
    return out;
  }
  return value;
}

/** A section's props with the gated fields and items this viewer may not see removed. */
export function filterSectionProps(
  section: EventSection,
  viewer: EventViewer,
  options: FilterOptions = {},
): EventSection['props'] {
  if (isPrivilegedViewer(viewer)) return section.props;
  const props = { ...(section.props as Record<string, unknown>) };
  const gates = props[FIELD_VISIBILITY_PROP];
  delete props[FIELD_VISIBILITY_PROP];
  if (gates && typeof gates === 'object' && !Array.isArray(gates)) {
    for (const [key, rule] of Object.entries(gates as Record<string, unknown>)) {
      if (!isRule(rule) || !ruleAllows(rule, viewer)) delete props[key];
    }
  }
  if (section.type === 'venue' && options.venueRevealed === false) {
    for (const key of VENUE_SECRET_PROPS) delete props[key];
  }
  return filterValue(props, viewer, options) as EventSection['props'];
}

/** The document with only what this viewer may see. Never mutates its input. */
export function filterDocForViewer(
  doc: EventDoc,
  viewer: EventViewer,
  options: FilterOptions = {},
): EventDoc {
  if (isPrivilegedViewer(viewer)) return doc;
  return {
    ...doc,
    sections: doc.sections
      .filter((s) => sectionVisibleTo(s, viewer))
      .map((s) => ({ ...s, props: filterSectionProps(s, viewer, options) })),
  };
}

/* ------------------------------------------------------------- sessions */

/** Whether a session is visible to this viewer (its visible_to_tags). */
export function sessionVisibleTo(
  session: Pick<EventSession, 'id' | 'visible_to_tags'>,
  viewer: EventViewer,
): boolean {
  if (isPrivilegedViewer(viewer)) return true;
  if (!session.visible_to_tags.length) return true;
  // A guest already placed in the session sees it whatever their tags.
  if (viewer.rsvp && viewer.rsvp[session.id]) return true;
  return hasAnyTag(viewer, session.visible_to_tags);
}

/* ---------------------------------------------------------------- venue */

/** Whether the reveal rule shows the address to this viewer. */
export function venueRevealedTo(reveal: EventVenueReveal, viewer: EventViewer): boolean {
  if (isPrivilegedViewer(viewer)) return true;
  if (reveal === 'public') return true;
  if (reveal === 'registered') return viewer.registered;
  return viewer.going;
}

/** The venue as this viewer may see it: address, maps and online links only when revealed. */
export function venueForViewer(venue: EventVenue, viewer: EventViewer): EventVenuePublic {
  const revealed = venueRevealedTo(venue.reveal, viewer);
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

/* --------------------------------------------------------------- viewer */

/** The viewer a guest (by personal link or remembered cookie) is. */
export function viewerForGuest(
  guest: Pick<EventGuest, 'id' | 'first_name' | 'last_name' | 'company' | 'tags'>,
  rows: readonly Pick<EventGuestSession, 'guest_id' | 'session_id' | 'status'>[],
): EventViewer {
  const rsvp: Record<string, EventGuestStatus> = {};
  for (const r of rows) if (r.guest_id === guest.id) rsvp[r.session_id] = r.status;
  const statuses = Object.values(rsvp);
  const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim() || null;
  return {
    kind: 'guest',
    guestId: guest.id,
    firstName: guest.first_name?.trim() || null,
    name,
    company: guest.company?.trim() || null,
    tags: [...guest.tags],
    registered: statuses.some((s) => REGISTERED.has(s)),
    going: statuses.includes('going'),
    rsvp,
  };
}
