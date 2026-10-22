/**
 * EVENTS v1 — THE CROSS-WORKSTREAM CONTRACT (D-075).
 *
 * Five workstreams build Events in parallel from one contract commit:
 *
 *   WS1 Platform      data, schema, ops/merge, events service, publish, media
 *   WS2 Design        themes, effects, blocks, the guest renderer, OG card
 *   WS3 Studio        the editor, outside edit links, presence, history UI
 *   WS4 Guests        registration, guest list, check-in, the public routes
 *   WS5 Events tab    library, overview, settings, messages, Copilot wiring
 *
 * Every interface one workstream calls on another is declared HERE (types)
 * and, where code must exist on day 0, STUBBED at its owner's path so the
 * callers compile and run in demo mode before the real thing lands. An owner
 * replaces its stub's body; it never changes a signature below without
 * updating this file in the same commit and telling the others.
 *
 * Stubs at owners' paths (replace the body, keep the export):
 *
 *   WS2  src/components/events/render/event-page.tsx   EventPage (plain fallback renderer)
 *   WS2  src/lib/events/og.tsx                         renderOgImage (returns null)
 *   WS2  src/lib/events/blocks/index.ts                blockRegistry (generic guards only)
 *   WS2  src/lib/events/themes/index.ts                THEME_PRESETS (TipTop Signature only)
 *   WS2  src/lib/events/starters/index.ts              STARTERS (Blank only)
 *   WS2  src/lib/events/richtext.ts                    renderRichText (plain paragraphs)
 *   WS3  src/lib/events/editor-auth.ts                 grant cookie, resolveGrant, claimGrant, enforceOpScope
 *   WS3  src/components/events/sharing/sharing-panel.tsx      SharingPanel (placeholder)
 *   WS4  src/components/events/rsvp/rsvp-slot.tsx      RsvpSlot (placeholder)
 *   WS4  src/lib/events/visibility.ts                  filterDocForViewer (working minimal rules)
 *   WS4  src/lib/services/event-guests.ts              guestCounts (working), audiences + needs-notifying (empty)
 *   WS4  src/components/events/guests/guests-panel.tsx              GuestsPanel (placeholder)
 *   WS4  src/components/events/registration/registration-panel.tsx  RegistrationPanel (placeholder)
 *   WS4  src/components/events/checkin/checkin-panel.tsx            CheckinPanel (placeholder)
 *   WS1  src/lib/services/events.ts, event-versions.ts, event-media.ts (see SERVICES below)
 *
 * Shared, owned by WS1, final in this commit (others import, never edit):
 *   lib/events/schema.ts        EventDoc zod schema, block/theme/effect enums
 *   lib/events/ops.ts           DraftOp types, DraftOpsRequest/Result, invertOp
 *   lib/events/merge.ts         applyOps (property-level merge), changesSince
 *   lib/events/capabilities.ts  EventCapabilities + predicates (checkOp)
 *   lib/events/fractional.ts    section order keys
 *   lib/events/surface.ts       public-surface flag + /e nonce CSP
 *   lib/events/doc.ts           new documents and sections (createEvent, Studio's "Add section")
 *   lib/types/domain.ts         Event* row types; lib/db/store.ts TableMap
 *   lib/security/audit.ts       event.* audit actions
 *
 * HARD RULES every workstream codes to:
 *   1. No raw HTML, CSS or JS from any event content, ever. Guest/outsider
 *      text renders as React text nodes; rich text through lib/events/richtext.ts
 *      (WS2) into React nodes. No dangerouslySetInnerHTML outside the root
 *      layout's two static constants.
 *   2. /e/* pages are same-origin with Copilot: they get a strict nonce CSP
 *      (lib/events/surface.ts via proxy.ts), must be dynamically rendered, and
 *      load no third-party script (Turnstile only when enabled). Embeds are
 *      allowlisted ids, loaded on click.
 *   3. Public routes expose nothing else in Copilot: they call only the narrow
 *      event services with (organizationId, eventId, actor) and return
 *      whitelisted fields. Guest emails never appear on a public page.
 *   4. Nothing sends email on its own. Every guest email is a campaign draft
 *      a person reviews and confirms in the existing campaign flow.
 *   5. Gated sections and media are removed on the SERVER for viewers who do
 *      not qualify (filterDocForViewer, signed URLs), never hidden with CSS.
 *   6. Fictional data only in tests, fixtures, starters and docs (the repo
 *      is public).
 *   7. Link from Copilot pages to /e/* with a plain <a> (new tab), never
 *      next/link: a full document load is what gives the guest page its own
 *      CSP and chrome-free layout.
 */

import type { EventCapabilities } from './capabilities';
import type { DraftChanges } from './ops';
import type {
  BlockType,
  BlockVariant,
  EventDoc,
  EventSection,
  EventTheme,
  SectionProps,
} from './schema';
import type {
  EventAccess,
  EventEditorRole,
  EventEditorScope,
  EventGuestStatus,
  EventGuestWall,
  EventMediaKind,
  EventQuestionType,
  EventRecord,
  EventSession,
  EventResponseSet,
  EventStatus,
  EventVenue,
  EventVenueKind,
  EventVenueReveal,
  EventVisibility,
} from '@/lib/types/domain';

/* =================================================================== URLS */

/** The public URL scheme. Paths are app-relative; prefix APP_URL for emails. */
export const eventPaths = {
  page: (slug: string) => `/e/${slug}`,
  calendar: (slug: string, sessionId?: string) =>
    `/e/${slug}/calendar.ics${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`,
  /** Personal invite / ticket. GET is read-only. */
  invite: (slug: string, token: string) => `/e/${slug}/i/${token}`,
  inviteCalendar: (slug: string, token: string) => `/e/${slug}/i/${token}/calendar.ics`,
  /** The QR code on a ticket. */
  checkinQr: (slug: string, token: string) => `/e/${slug}/c/${token}`,
  /** Outside-editor entry: the secret travels in the fragment, never to the server on GET. */
  editEntry: (secret: string) => `/e/edit#k=${secret}`,
  editStudio: (eventId: string) => `/e/edit/${eventId}`,
  staffEntry: (secret: string) => `/e/checkin#k=${secret}`,
  doorList: (eventId: string) => `/e/checkin/${eventId}`,
  /** Signed-in. */
  studio: (eventId: string) => `/events/${eventId}/studio`,
  detail: (eventId: string, tab?: EventDetailTab) =>
    `/events/${eventId}${tab ? `?tab=${tab}` : ''}`,
  library: () => '/events',
} as const;

export const EVENT_DETAIL_TABS = [
  'overview',
  'page',
  'guests',
  'registration',
  'messages',
  'checkin',
  'sharing',
  'settings',
] as const;
export type EventDetailTab = (typeof EVENT_DETAIL_TABS)[number];

/** Slugs: ^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$, minus the words the routes use. */
export const EVENT_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
export const RESERVED_EVENT_SLUGS = ['edit', 'checkin', 'api', 'new', 'i', 'c'] as const;

/* ================================================================ ACTORS */

/**
 * Who is acting on an event, as every service takes it. Owners come from the
 * Copilot session (getAuthContext + has_org_role member); grants from WS3's
 * resolveGrant (the tiptop_ev_grant cookie, re-checked on every request).
 */
export type EventActor =
  | { kind: 'owner'; userId: string; organizationId: string; name: string }
  | { kind: 'grant'; grant: EventGrant; name: string };

/** 'u:<user id>' or 'g:<grant id>': event_edits, event_presence, check-ins. */
export function actorKey(actor: EventActor): string {
  return actor.kind === 'owner' ? `u:${actor.userId}` : `g:${actor.grant.grantId}`;
}

export function actorOrganizationId(actor: EventActor): string {
  return actor.kind === 'owner' ? actor.organizationId : actor.grant.organizationId;
}

/* ================================================================ GRANTS */

/** The httpOnly, Secure, SameSite=Strict cookie a claimed link sets. */
export const GRANT_COOKIE = 'tiptop_ev_grant';
/** Sliding lifetime of a claimed session, never beyond the grant's expiry. */
export const GRANT_SESSION_HOURS = 12;
/** Link expiry choices (days); default 14, max 90. */
export const GRANT_EXPIRY_DAYS = [3, 7, 14, 30, 90] as const;
export const GRANT_DEFAULT_EXPIRY_DAYS = 14;
export const GRANT_MAX_EXPIRY_DAYS = 90;

/** A live, re-checked outside link (WS3's resolveGrant returns it). */
export interface EventGrant {
  grantId: string;
  eventId: string;
  organizationId: string;
  role: EventEditorRole;
  scope: EventEditorScope;
  label: string;
  tokenVersion: number;
  expiresAt: string;
  /** Effective for this request: role, scope, brand locks, editing_paused. */
  capabilities: EventCapabilities;
}

/* ================================================================= MEDIA */

export interface ResolvedMediaVariant {
  w: number;
  format: 'avif' | 'webp' | 'jpg' | 'png' | 'mp4' | 'webm';
  url: string;
}

/**
 * A media item ready to render: public URLs for published ungated media,
 * 15-minute signed URLs for gated media the viewer qualifies for. The
 * renderer never sees storage paths and never builds URLs itself.
 */
export interface ResolvedMedia {
  id: string;
  kind: EventMediaKind;
  width: number | null;
  height: number | null;
  alt: string | null;
  decorative: boolean;
  thumbhash: string | null;
  colors: string[];
  variants: ResolvedMediaVariant[];
  /** The best single URL (largest JPEG/WebP image, or the video file). */
  src: string | null;
  posterUrl: string | null;
  /** Files (Materials): the download name. */
  fileName: string | null;
  gated: boolean;
  status: 'uploaded' | 'ready' | 'failed';
}

/** mediaId → resolved media, for the ids a doc references. Missing ids render a placeholder. */
export type MediaMap = Record<string, ResolvedMedia>;

/* ========================================================= PUBLIC FACTS */

/** The venue as THIS viewer may see it (the reveal rule already applied, server-side). */
export interface EventVenuePublic {
  kind: EventVenueKind;
  name: string | null;
  /** Null when not revealed to this viewer. */
  address: string | null;
  lat: number | null;
  lng: number | null;
  mapsUrl: string | null;
  onlineUrl: string | null;
  notes: string | null;
  revealRule: EventVenueReveal;
  revealed: boolean;
}

export interface EventSessionPublic {
  id: string;
  name: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Null: the event's venue. */
  venue: EventVenuePublic | null;
  /** Spots left when the host shows them, else null. */
  remaining: number | null;
  full: boolean;
  waitlistOpen: boolean;
  requiresApproval: boolean;
}

export interface EventQuestionPublic {
  id: string;
  type: EventQuestionType;
  label: string;
  help: string | null;
  required: boolean;
  options: string[];
  sessionId: string | null;
  askPlusOnes: boolean;
}

/**
 * Settings-derived facts the page shows (Key details, Agenda, Venue,
 * Countdown, the RSVP form). Built by WS4's event-public.ts for guests and by
 * WS3 for Studio; whitelisted: no emails, no host notes, no counts the host
 * did not choose to show.
 */
export interface EventPublicFacts {
  id: string;
  slug: string;
  title: string;
  status: EventStatus;
  visibility: EventVisibility;
  timeZone: string;
  startsAt: string | null;
  endsAt: string | null;
  venue: EventVenuePublic | null;
  /** Only the sessions this viewer may see (visible_to_tags applied). */
  sessions: EventSessionPublic[];
  access: EventAccess;
  registrationOpen: boolean;
  closesAt: string | null;
  cancelled: { message: string | null } | null;
  /** The ICS SEQUENCE. */
  scheduleVersion: number;
  publishedVersion: number;
  /** Absolute URL of the published OG card, when one exists. */
  ogImageUrl: string | null;
  /** App-relative page path: /e/<slug>. */
  path: string;
}

/* ================================================================ VIEWER */

export type EventViewerKind = 'public' | 'guest' | 'owner' | 'editor' | 'viewer';

/**
 * Who is looking at the page. Resolved by WS4 (personal token, the
 * remembered-RSVP cookie scoped to /e/<slug>, or nothing) and by WS3 for
 * Studio's "Preview as". Drives personalization ({{first_name}}) and the
 * visibility filter.
 */
export interface EventViewer {
  kind: EventViewerKind;
  guestId: string | null;
  firstName: string | null;
  name: string | null;
  company: string | null;
  tags: string[];
  /** Any session status other than invited/declined/not_going. */
  registered: boolean;
  /** Going to at least one session. */
  going: boolean;
  /** Per-session status, when the viewer is a guest. */
  rsvp: Record<string, EventGuestStatus> | null;
}

export const PUBLIC_VIEWER: EventViewer = {
  kind: 'public',
  guestId: null,
  firstName: null,
  name: null,
  company: null,
  tags: [],
  registered: false,
  going: false,
  rsvp: null,
};

/** Studio's sample guest for "Preview as invited guest" when no real guest is picked. */
export const SAMPLE_GUEST_VIEWER: EventViewer = {
  kind: 'guest',
  guestId: null,
  firstName: 'Sarah',
  name: 'Sarah Sample',
  company: 'Example Partners',
  tags: [],
  registered: false,
  going: false,
  rsvp: null,
};

/* ============================================================= RENDERING */

/**
 * live: the public page. studio: inside Studio's device frame (selection
 * attributes, no network, no intro unless previewed). preview: owners' and
 * viewer links' draft preview. og: server-side share-card capture.
 */
export type EventRenderMode = 'live' | 'studio' | 'preview' | 'og';
export type MotionPreview = 'full' | 'reduced' | 'off';

export interface EventRegistrationPublic {
  access: EventAccess;
  open: boolean;
  closesAt: string | null;
  showRemaining: boolean;
  responseSet: EventResponseSet;
  plusOnes: { max: number; perSession: boolean; collectEmail: boolean; askQuestions: boolean };
  /** Only the questions this viewer is asked (session visibility applied). */
  questions: EventQuestionPublic[];
  sessions: EventSessionPublic[];
  requestInvite: boolean;
  guestWall: EventGuestWall;
  /** Set only when Turnstile is enabled for this (open, public) event. */
  turnstileSiteKey: string | null;
}

/** Everything the RSVP block's slot needs, built by the page route (WS4). */
export interface EventRsvpContext {
  /** POST target: /api/e/<slug>/rsvp or /api/e/<slug>/i/<token>/respond. Null in studio/og. */
  endpoint: string | null;
  /** Signed render timestamp for the spam check (lib/events/public-gate.ts). */
  formToken: string | null;
  registration: EventRegistrationPublic;
  viewer: EventViewer;
  /** The viewer's ticket page, when they have one. */
  ticketPath: string | null;
}

/**
 * Props of WS2's EventPage. EventPage is ISOMORPHIC: synchronous, no
 * server-only imports, no browser APIs at module scope, effects as lazily
 * loaded client islands. The public route renders it as a server component;
 * Studio renders the same component inside its client canvas.
 *
 * DOM contract (Studio and tests rely on it):
 *   - root element: data-event-root, id="main" (the layout's skip link);
 *   - every section root: data-section-id={id} data-block={type};
 *   - in mode 'studio', every inline-editable plain-text prop element:
 *     data-field="props.<key>";
 *   - scoped CSS only ([data-event-root]), --ev-* custom properties, container
 *     queries (the Studio frame is not the viewport).
 */
export interface EventPageProps {
  /** Already filtered for this viewer (filterDocForViewer) — render what you get. */
  doc: EventDoc;
  facts: EventPublicFacts;
  media: MediaMap;
  viewer: EventViewer;
  mode: EventRenderMode;
  /** Studio's motion preview; the live page follows prefers-reduced-motion and the theme. */
  motion?: MotionPreview;
  /** Null: render the RSVP block's static shell (studio/og/cancelled). */
  rsvp: EventRsvpContext | null;
  /** Studio: the section to outline. */
  selectedSectionId?: string | null;
  /** The request's CSP nonce, for any inline <script> an island needs (prefer none). */
  nonce?: string;
}

/**
 * Props of WS4's RsvpSlot, mounted by WS2's RSVP block (a client component).
 * Labels come from the block's props as plain text; the form's wiring
 * (questions, sessions, endpoint) is owner-only and comes from settings.
 */
export interface RsvpSlotProps {
  variant: BlockVariant<'rsvp'>;
  labels: { cta: string; going: string; maybe: string; notGoing: string };
  mode: EventRenderMode;
  context: EventRsvpContext | null;
}

/** Input to WS2's renderOgImage (lib/events/og.tsx): a 1200×630 PNG. */
export interface OgImageInput {
  doc: EventDoc;
  facts: EventPublicFacts;
  media: MediaMap;
  layout: 'cover' | 'type' | 'ticket';
}

/** Null: no card (publish proceeds without one). WS1's publish stores og/<event>/v<n>.png. */
export type RenderOgImage = (input: OgImageInput) => Promise<Uint8Array | null>;

/* ======================================================= BLOCK REGISTRY */

export type FieldKind =
  | 'text'
  | 'richtext'
  | 'media'
  | 'person'
  | 'list'
  | 'select'
  | 'toggle'
  | 'color_token'
  | 'link'
  | 'number'
  | 'datetime';

/** Drives Studio's inspector form (WS3 generates the form from these). */
export interface FieldDescriptor {
  /** The props key. */
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  /** Editable inline on the canvas (plain text only). */
  inline?: boolean;
  /** Owners only (e.g. RSVP form wiring); outsiders see it locked. */
  ownerOnly?: boolean;
  max?: number;
  options?: { value: string; label: string }[];
  /** For kind 'list': the fields of one item. */
  itemFields?: FieldDescriptor[];
  maxItems?: number;
}

export interface BlockDefinition {
  type: BlockType;
  label: string;
  description: string;
  variants: readonly string[];
  /** A new section's variant and props (no lorem ipsum: empty slots show "Add photo"). */
  defaults: () => { variant: string; props: SectionProps };
  fields: FieldDescriptor[];
  /** One line for the outline and the publish diff: "Agenda – 2 items". */
  summary: (props: SectionProps) => string;
}

/** WS2's lib/events/blocks exports one `blockRegistry` of this shape. */
export interface BlockRegistry {
  get(type: BlockType): BlockDefinition | undefined;
  list(): BlockDefinition[];
  /** Strict per-block props check; [] when valid (schema.ts BlockPropsValidator). */
  validateProps(type: BlockType, variant: string, props: SectionProps): string[];
  isOwnerOnlyProp(type: BlockType, key: string): boolean;
  /** Per-engine theme checks (effect options); [] when valid. */
  validateTheme(theme: EventTheme): string[];
}

/* ===================================================== THEMES & STARTERS */

export type ThemeVibe = 'formal' | 'modern' | 'playful' | 'golf' | 'night' | 'seasonal';

/** A theme preset (WS2, lib/events/themes): a whole theme minus merge bookkeeping. */
export interface ThemePreset {
  id: string;
  name: string;
  vibes: ThemeVibe[];
  /** 'launch' (24) or 'wave2' (9). */
  wave: 'launch' | 'wave2';
  description: string;
  theme: Omit<EventTheme, 'rev' | 'keyRevs'>;
}

export interface StarterSession {
  name: string;
  /** Minutes after the event's start, and duration; the dialog's times win. */
  offsetMinutes: number;
  durationMinutes: number;
  capacity: number | null;
}

/** A starter page (WS2, lib/events/starters): fictional copy only. */
export interface StarterDoc {
  id: string;
  name: string;
  description: string;
  themePresetId: string;
  access: EventAccess;
  visibility: EventVisibility;
  sessions: StarterSession[];
  /** In order; ids and positions are assigned when the event is created. */
  sections: Omit<EventSection, 'id' | 'position' | 'rev' | 'keyRevs'>[];
}

/* =========================================================== GUEST SIDE */

export interface GuestCounts {
  going: number;
  pending: number;
  waitlist: number;
  invited: number;
  maybe: number;
  notGoing: number;
  declined: number;
  checkedIn: number;
  /** Plus-ones among going. */
  plusOnes: number;
  total: number;
}

export const EMPTY_GUEST_COUNTS: GuestCounts = {
  going: 0,
  pending: 0,
  waitlist: 0,
  invited: 0,
  maybe: 0,
  notGoing: 0,
  declined: 0,
  checkedIn: 0,
  plusOnes: 0,
  total: 0,
};

/** Who a campaign goes to (WS5 asks WS4's resolveAudience). */
export type EventAudience =
  | { kind: 'all'; sessionId?: string | null }
  | { kind: 'status'; statuses: EventGuestStatus[]; sessionId?: string | null }
  | { kind: 'tag'; tag: string; sessionId?: string | null }
  | { kind: 'checked_in'; sessionId?: string | null }
  | { kind: 'guests'; guestIds: string[] };

export interface AudienceMember {
  guestId: string;
  email: string;
  firstName: string | null;
  name: string | null;
  company: string | null;
  recordId: string | null;
  /** App-relative personal link: /e/<slug>/i/<token> (WS5 prefixes APP_URL). */
  rsvpPath: string;
}

/** The "Needs notifying (N)" queue: status changes no sent campaign has told the guest about. */
export type NotifyKind = 'confirmed' | 'waitlisted' | 'promoted' | 'declined' | 'pending';

export interface NeedsNotifyingGroup {
  kind: NotifyKind;
  /** (guest, session) pairs; one message per kind. */
  items: { guestId: string; sessionId: string; status: EventGuestStatus }[];
}

/* ================================================================ PANELS */

/**
 * Props of the event-detail subtab panels WS5's /events/[id] page mounts:
 * SharingPanel (WS3), GuestsPanel, RegistrationPanel, CheckinPanel (WS4).
 * Panels are SERVER components (they may be async and load their own data
 * with the store) that render their own client islands; never pass `event`
 * itself to a client component (draft_doc would be serialized).
 */
export interface EventPanelProps {
  event: EventRecord;
  sessions: EventSession[];
  viewer: {
    userId: string;
    organizationId: string;
    name: string;
    timeZone: string;
    capabilities: EventCapabilities;
  };
}

/* ============================================================ SERVICES */

/** A library card (WS5) — from WS1's listEvents. */
export interface EventSummary {
  id: string;
  slug: string;
  title: string;
  status: EventStatus;
  visibility: EventVisibility;
  access: EventAccess;
  timeZone: string;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  isTemplate: boolean;
  /** Published OG card URL, else null (cards then show the swatch). */
  ogImageUrl: string | null;
  swatch: { bg: string; accent: string; text: string } | null;
  /** draft_version moved since the last publish. */
  hasUnpublishedChanges: boolean;
  counts: GuestCounts;
}

export type EventLibraryTab = 'upcoming' | 'drafts' | 'past' | 'templates';

export interface CreateEventInput {
  title: string;
  /** Generated from the title when omitted. */
  slug?: string;
  timeZone?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  /** Additional sessions; one session matching the event is always created. */
  sessions?: {
    name: string;
    startsAt: string | null;
    endsAt: string | null;
    capacity?: number | null;
  }[];
  venue?: Partial<EventVenue>;
  starterId?: string;
  themePresetId?: string;
}

/** GET …/draft. */
export interface DraftSnapshot {
  doc: EventDoc;
  version: number;
  editingPaused: boolean;
  publishedVersion: number;
  /** draft_version at the last publish (0: never published). */
  publishedDraftVersion: number;
}

export interface PresenceEntry {
  actorKey: string;
  name: string;
  color: string;
  outside: boolean;
  focusedSectionId: string | null;
  typing: boolean;
  lastSeenAt: string;
  /** Seen in the last 20 s (soft-lock window). */
  active: boolean;
}

/** GET …/draft/sync?since=n (WS3 polls; WS1 implements the read). */
export interface DraftSyncResult {
  version: number;
  /** The whole doc when `since` is older than the edit log reaches; else null. */
  full: EventDoc | null;
  changes: DraftChanges;
  presence: PresenceEntry[];
  editingPaused: boolean;
  publishedVersion: number;
}

/** POST …/publish. */
export interface PublishResult {
  publishedVersion: number;
  path: string;
  ogImageUrl: string | null;
}

/**
 * SERVICE SIGNATURES (all return Result<T> from lib/util/result; all take
 * the DataStore first and an explicit organizationId; none throws for an
 * expected failure; a missing table degrades to `not_configured`):
 *
 * WS1 lib/services/events.ts
 *   listEvents(store, orgId, { tab?, search? })              → EventSummary[]
 *   getEvent(store, orgId, eventId)                          → EventRecord
 *   getEventSessions(store, orgId, eventId)                  → EventSession[]
 *   createEvent(store, owner, CreateEventInput)              → EventRecord
 *   updateEventSettings(store, owner, eventId, patch)        → EventRecord      (part 2)
 *   getDraft(store, actor, eventId)                          → DraftSnapshot
 *   applyDraftOps(store, actor, eventId, DraftOpsRequest, { ip }) → DraftOpsResult
 *   syncDraft(store, actor, eventId, since, presence)        → DraftSyncResult  (part 2)
 *   publishEvent(store, owner, eventId, expectedDraftVersion) → PublishResult   (part 2)
 *   unpublishEvent / cancelEvent / archiveEvent / deleteEvent / duplicateEvent (part 2)
 * WS1 lib/services/event-versions.ts   listVersions, createNamedVersion, restoreVersion (part 2)
 * WS1 lib/services/event-media.ts      createUploadUrl, processMedia, updateMedia, resolveMedia (part 2)
 * WS3 lib/events/editor-auth.ts        resolveGrant, claimGrant, enforceOpScope, grantCookie helpers
 * WS3 lib/services/event-editors.ts    create/list/update/regenerate/revoke/revokeAll links
 * WS4 lib/services/event-guests.ts     guestCounts, listGuests, resolveAudience, needsNotifying, markNotified
 * WS4 lib/services/event-public.ts     published-doc read, viewer resolution, facts, visibility filtering
 * WS4 lib/events/tokens.ts             personal invite / check-in HMAC tokens (event-rsvp/v1, event-checkin/v1)
 * WS5 lib/services/event-comms.ts      campaign drafts (invite/reminder/notice/update/blast)
 *
 * HTTP routes live in this commit (signed in, src/lib/events/route-helpers.ts):
 *   GET  /api/events?tab=&q=          → { events: EventSummary[] }
 *   POST /api/events                  CreateEventInput → { id, slug }
 *   GET  /api/events/[id]             → { event (no docs, no password hash), sessions }
 *   GET  /api/events/[id]/draft       → DraftSnapshot
 *   POST /api/events/[id]/draft/ops   DraftOpsRequest → DraftOpsResult (256 KB body cap)
 * Every other route in the spec's list comes with its owner's workstream.
 */

/* ===================================================== INTEGRATION NOTES */

/**
 * - Rows without an `id` column: event_guest_sessions (guest_id, session_id),
 *   event_presence (event_id, actor_key), event_slug_aliases (slug). Use
 *   list/findOne/updateWhere/removeWhere/upsert on them, never get/update/remove.
 * - Slugs are globally unique (one URL namespace). The deployment is single
 *   tenant: public routes resolve the organization with soleOrganizationId()
 *   (lib/db/tenancy.ts), then filter by organization_id AND event id/slug.
 * - Demo data: src/lib/demo/events-fixtures.ts (DEMO_EVENT_IDS,
 *   DEMO_EVENT_SLUGS): a published invite-only two-session event with five
 *   fictional guests and a plus-one, an outside editor link, and a draft.
 * - The public-surface flag already covers booking's /meet (D-074).
 * - Studio's route: WS3 checks that Next accepts the (focus) group split for
 *   /events/[id]/studio; the fallback is /events-studio/[id] (update
 *   eventPaths.studio if so).
 * - Media URLs are never built in components: the page route resolves a
 *   MediaMap (event-media.ts resolveMedia) and passes it to EventPage.
 */
