import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { blockRegistry } from '@/lib/events/blocks';
import {
  capabilitiesForGrant,
  checkOp,
  themeLocks,
  type BrandLocks,
  type EventCapabilities,
} from '@/lib/events/capabilities';
import {
  EVENT_SLUG_RE,
  GRANT_COOKIE,
  GRANT_SESSION_HOURS,
  eventPaths,
  type EventGrant,
} from '@/lib/events/contracts';
import type { DraftOp, OpConflict } from '@/lib/events/ops';
import {
  parseEventDoc,
  type BlockType,
  type EventDoc,
  type SectionProps,
} from '@/lib/events/schema';
import { recordAudit } from '@/lib/security/audit';
import { addressBucket } from '@/lib/security/client-address';
import { hashIp, signedValue, verifySignedValue } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { EventEditor, EventEditorRole, EventRecord, Organization } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Outside links (D-075): edit, viewer and check-in-staff links for people
 * with no Copilot account. WS3 owns this file; WS1's ops service and WS4's
 * staff routes call it.
 *
 *   Link      /e/edit#k=<43-char secret>  (staff: /e/checkin#k=…)
 *             The secret is 256 random bits (randomToken(32)) in the URL
 *             FRAGMENT, so it never reaches the server on a GET, a Referer
 *             header or a log. Only its SHA-256 and a 4-character hint are
 *             stored (event_editors.token_hash / token_hint).
 *   Claim     The entry page strips the fragment (history.replaceState) and
 *             an explicit click POSTs the secret (claimGrant): mail scanners
 *             and link prefetch cannot claim. The answer sets a signed,
 *             httpOnly, Secure, SameSite=Strict cookie `tiptop_ev_grant`
 *             holding {grant, org, event, token version, expiry}, scoped by
 *             PATH to that one event's pages and API (grantCookiePaths), for
 *             12 hours sliding and never past the link's own expiry.
 *   Every     request re-checks the row (resolveGrant): revoked, expired,
 *             token version (Regenerate bumps it and ends every session),
 *             the event, the role and, through capabilities.ts, the scope,
 *             the brand locks and editing_paused. Unknown, expired, revoked
 *             or mismatched: one generic not_found, never which.
 *   Limits    claims and token lookups: 10 per 10 minutes per address bucket.
 *
 * Outsiders hold no Supabase credentials and no Copilot session; nothing a
 * grant resolves to reaches beyond the draft of its one event.
 */

export { GRANT_COOKIE };

/** A link's secret: 32 random bytes, base64url, so exactly 43 characters. */
export const GRANT_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
/** Claims (and pre-claim lookups) per address bucket per window. */
export const CLAIM_LIMIT = 10;
export const CLAIM_WINDOW_MS = 10 * 60_000;
/** last_used_at is written at most this often (the sync poll runs every 2 s). */
const TOUCH_EVERY_MS = 60_000;
/** A session cookie is re-issued when less than this is left (sliding 12 h). */
const REFRESH_BELOW_MS = (GRANT_SESSION_HOURS - 1) * 3_600_000;

const NOT_VALID = 'This link is not valid.';
const notValid = <T>(): Result<T> => err('not_found', NOT_VALID);

/** The roles the edit pages and their API accept. Staff routes pass ['checkin']. */
export const EDIT_ROLES: readonly EventEditorRole[] = ['editor', 'viewer'];

/** SHA-256 of a link secret, as event_editors.token_hash stores it. */
export function hashGrantSecret(secret: string): string {
  return sha256(secret);
}

/* ------------------------------------------------------------ the cookie */

interface GrantCookiePayload {
  /** event_editors.id */
  g: string;
  /** organization */
  o: string;
  /** event */
  e: string;
  /** token_version at claim time */
  v: number;
  /** expiry, epoch ms */
  x: number;
}

function sealCookie(payload: GrantCookiePayload): string {
  return signedValue(JSON.stringify(payload));
}

/** A cookie value's payload, or null when it is forged, malformed or expired. */
export function readGrantCookie(
  value: string | null | undefined,
  now: number = Date.now(),
): GrantCookiePayload | null {
  if (!value || value.length > 1024) return null;
  const raw = verifySignedValue(value);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<GrantCookiePayload>;
    if (
      typeof p.g !== 'string' ||
      typeof p.o !== 'string' ||
      typeof p.e !== 'string' ||
      typeof p.v !== 'number' ||
      typeof p.x !== 'number'
    ) {
      return null;
    }
    if (p.x <= now) return null;
    return p as GrantCookiePayload;
  } catch {
    return null;
  }
}

/**
 * The paths a claimed link's cookie is set on: that one event's pages and
 * API, nothing else in Copilot. Edit and viewer links: /e/edit/<id> and
 * /api/e/edit/<id>. Staff links: /e/checkin/<id> and /api/e/checkin/<id>,
 * plus the event's QR landing paths /e/<slug>/c and /api/e/<slug>/c when the
 * slug is given.
 */
export function grantCookiePaths(
  role: EventEditorRole,
  eventId: string,
  slug?: string | null,
): string[] {
  if (role !== 'checkin') return [eventPaths.editStudio(eventId), `/api/e/edit/${eventId}`];
  const paths = [eventPaths.doorList(eventId), `/api/e/checkin/${eventId}`];
  // A ticket's QR lands on /e/<slug>/c/<token>; staff check people in there
  // too, so the staff cookie also rides on that event's QR landing paths.
  if (slug && EVENT_SLUG_RE.test(slug)) paths.push(`/e/${slug}/c`, `/api/e/${slug}/c`);
  return paths;
}

export interface GrantCookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: 'strict';
    path: string;
    maxAge: number;
  };
}

/** The Set-Cookie specs for a claimed (or refreshed) session: one per path. */
export function grantCookies(
  role: EventEditorRole,
  eventId: string,
  value: string,
  maxAgeSeconds: number,
  slug?: string | null,
): GrantCookieSpec[] {
  const secure = process.env.NODE_ENV === 'production';
  return grantCookiePaths(role, eventId, slug).map((path) => ({
    name: GRANT_COOKIE,
    value,
    options: { httpOnly: true, secure, sameSite: 'strict', path, maxAge: maxAgeSeconds },
  }));
}

/**
 * One Set-Cookie header value. The same cookie name on two paths needs two
 * headers, which Next's response.cookies (keyed by name) cannot hold, so
 * routes append these instead.
 */
export function serializeGrantCookie(spec: GrantCookieSpec): string {
  const parts = [
    `${spec.name}=${spec.value}`,
    `Path=${spec.options.path}`,
    `Max-Age=${spec.options.maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (spec.options.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (spec.options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Append a session's cookies (one header per path) to a response's headers. */
export function appendGrantCookies(headers: Headers, specs: readonly GrantCookieSpec[]): void {
  for (const spec of specs) headers.append('Set-Cookie', serializeGrantCookie(spec));
}

/** Expiring cookies that clear a session on every path it was set on. */
export function clearedGrantCookies(
  role: EventEditorRole,
  eventId: string,
  slug?: string | null,
): GrantCookieSpec[] {
  return grantCookies(role, eventId, '', 0, slug);
}

/* ------------------------------------------------------------- lookups */

function guardMissing(error: unknown, operation: string): Result<never> {
  if (!isMissingTableError(error) && !isMissingColumnError(error)) {
    log.error('Outside link check failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  // Whatever went wrong, an outsider learns only that the link is not valid.
  return notValid();
}

/** The organizations to look a secret up in (single tenant: one). */
async function organizationIds(store: DataStore): Promise<string[]> {
  const rows = (await store.list('organizations', '', {})) as Organization[];
  return rows.map((o) => o.id);
}

async function findBySecret(
  store: DataStore,
  secret: string,
): Promise<{ editor: EventEditor; organizationId: string } | null> {
  const tokenHash = hashGrantSecret(secret);
  for (const organizationId of await organizationIds(store)) {
    const editor = await store.findOne('event_editors', organizationId, {
      eq: { token_hash: tokenHash },
    });
    if (editor) return { editor, organizationId };
  }
  return null;
}

function linkLive(editor: EventEditor, now: number): boolean {
  return editor.revoked_at === null && Date.parse(editor.expires_at) > now;
}

/** The doc's brand locks; every lock on when the draft cannot be read (fail closed). */
function locksOf(event: EventRecord): BrandLocks {
  const parsed = parseEventDoc(event.draft_doc);
  return parsed.ok
    ? themeLocks(parsed.value.theme)
    : { logo: true, palette: true, fonts: true, intro: true };
}

function grantOf(editor: EventEditor, event: EventRecord): EventGrant {
  const capabilities: EventCapabilities = capabilitiesForGrant(
    { role: editor.role, scope: editor.scope, editingPaused: event.editing_paused },
    locksOf(event),
  );
  return {
    grantId: editor.id,
    eventId: editor.event_id,
    organizationId: editor.organization_id,
    role: editor.role,
    scope: editor.scope,
    label: editor.label,
    tokenVersion: editor.token_version,
    expiresAt: editor.expires_at,
    capabilities,
  };
}

function claimLimited(ip: string | null): Result<true> {
  const key = `event-claim:${sha256(addressBucket(ip ?? 'unknown')).slice(0, 16)}`;
  const limited = rateLimit(key, CLAIM_LIMIT, CLAIM_WINDOW_MS);
  return limited.ok ? ok(true) : limited;
}

/* ------------------------------------------------------------- resolve */

export interface ResolveGrantInput {
  eventId: string;
  /** The raw tiptop_ev_grant cookie value. */
  cookieValue: string | null | undefined;
  /** Roles this route accepts (default: editor and viewer). */
  roles?: readonly EventEditorRole[];
  now?: number;
}

export interface GrantSession {
  grant: EventGrant;
  /** A re-issued cookie when the sliding window is running low; else null. */
  refresh: { value: string; maxAgeSeconds: number } | null;
}

/**
 * The cookie → a live grant, re-checked against the row and the event on
 * this request, plus a refreshed cookie when the 12-hour window runs low.
 */
export async function resolveGrantSession(
  store: DataStore,
  input: ResolveGrantInput,
): Promise<Result<GrantSession>> {
  const now = input.now ?? Date.now();
  const payload = readGrantCookie(input.cookieValue, now);
  if (!payload || payload.e !== input.eventId) return notValid();
  try {
    const editor = await store.get('event_editors', payload.o, payload.g);
    if (
      !editor ||
      editor.event_id !== input.eventId ||
      editor.organization_id !== payload.o ||
      editor.token_version !== payload.v ||
      !linkLive(editor, now) ||
      !(input.roles ?? EDIT_ROLES).includes(editor.role)
    ) {
      return notValid();
    }
    const event = await store.get('events', payload.o, input.eventId);
    if (!event || event.status === 'archived') return notValid();

    if (!editor.last_used_at || now - Date.parse(editor.last_used_at) > TOUCH_EVERY_MS) {
      await store
        .update('event_editors', payload.o, editor.id, {
          last_used_at: new Date(now).toISOString(),
        })
        .catch(() => undefined);
    }

    let refresh: GrantSession['refresh'] = null;
    if (payload.x - now < REFRESH_BELOW_MS) {
      const maxAgeSeconds = sessionSeconds(editor, now);
      if (maxAgeSeconds > 60) {
        refresh = {
          value: sealCookie({ ...payload, x: now + maxAgeSeconds * 1000 }),
          maxAgeSeconds,
        };
      }
    }
    return ok({ grant: grantOf(editor, event), refresh });
  } catch (error) {
    return guardMissing(error, 'resolveGrant');
  }
}

/** The cookie → a live EventGrant (the contract's entry point). */
export async function resolveGrant(
  store: DataStore,
  input: ResolveGrantInput,
): Promise<Result<EventGrant>> {
  const session = await resolveGrantSession(store, input);
  return session.ok ? ok(session.value.grant) : session;
}

/** Seconds a session may last from now: 12 h, never past the link's expiry. */
function sessionSeconds(editor: EventEditor, now: number): number {
  const untilExpiry = Math.floor((Date.parse(editor.expires_at) - now) / 1000);
  return Math.max(0, Math.min(GRANT_SESSION_HOURS * 3600, untilExpiry));
}

/* --------------------------------------------------------------- claim */

export interface ClaimGrantInput {
  /** The 43-character secret from the link's #k= fragment, POSTed by an explicit click. */
  token: string;
  ip: string | null;
  userAgent: string | null;
  /** Roles this entry accepts (default: editor and viewer; staff entry: ['checkin']). */
  roles?: readonly EventEditorRole[];
  now?: number;
}

export interface ClaimedGrant {
  grant: EventGrant;
  /** Value for the httpOnly, Secure, SameSite=Strict tiptop_ev_grant cookie. */
  cookieValue: string;
  maxAgeSeconds: number;
}

/** What the entry page shows before the click: who the link is for and what it allows. */
export interface GrantPreview {
  eventId: string;
  eventTitle: string;
  label: string;
  role: EventEditorRole;
  scope: EventEditor['scope'];
  /** Section names when the scope is a list of sections. */
  sectionNames: string[];
  expiresAt: string;
  editingPaused: boolean;
}

async function liveLink(
  store: DataStore,
  token: string,
  roles: readonly EventEditorRole[],
  now: number,
): Promise<Result<{ editor: EventEditor; event: EventRecord; organizationId: string }>> {
  if (!GRANT_SECRET_RE.test(token)) return notValid();
  const found = await findBySecret(store, token);
  if (!found || !linkLive(found.editor, now) || !roles.includes(found.editor.role)) {
    return notValid();
  }
  const event = await store.get('events', found.organizationId, found.editor.event_id);
  if (!event || event.status === 'archived') return notValid();
  return ok({ editor: found.editor, event, organizationId: found.organizationId });
}

/**
 * Side-effect free: who a secret is for, so the entry page can say "You've
 * been invited to edit {event} as {label}" before anyone clicks. Shares the
 * claim's per-address brake, so it cannot be used to test secrets.
 */
export async function previewGrant(
  store: DataStore,
  input: Omit<ClaimGrantInput, 'userAgent'>,
): Promise<Result<GrantPreview>> {
  const limited = claimLimited(input.ip);
  if (!limited.ok) return limited;
  const now = input.now ?? Date.now();
  try {
    const live = await liveLink(store, input.token, input.roles ?? EDIT_ROLES, now);
    if (!live.ok) return live;
    const { editor, event } = live.value;
    const parsed = parseEventDoc(event.draft_doc);
    const sectionNames =
      editor.scope.sections === 'all' || !parsed.ok
        ? []
        : parsed.value.sections
            .filter((s) => (editor.scope.sections as string[]).includes(s.id))
            .map((s) => s.name || blockRegistry.get(s.type)?.label || s.type);
    return ok({
      eventId: event.id,
      eventTitle: event.title,
      label: editor.label,
      role: editor.role,
      scope: editor.scope,
      sectionNames,
      expiresAt: editor.expires_at,
      editingPaused: event.editing_paused,
    });
  } catch (error) {
    return guardMissing(error, 'previewGrant');
  }
}

/**
 * The explicit claim: the POSTed secret → the grant and a session cookie.
 * Records first use and use from a new address or browser (owners are told,
 * lib/services/event-editors.ts listEditorNotices).
 */
export async function claimGrant(
  store: DataStore,
  input: ClaimGrantInput,
): Promise<Result<ClaimedGrant>> {
  const limited = claimLimited(input.ip);
  if (!limited.ok) return limited;
  const now = input.now ?? Date.now();
  try {
    const live = await liveLink(store, input.token, input.roles ?? EDIT_ROLES, now);
    if (!live.ok) return live;
    const { editor, event, organizationId } = live.value;
    const maxAgeSeconds = sessionSeconds(editor, now);
    if (maxAgeSeconds < 60) return notValid();

    const ipHash = hashIp(input.ip);
    const uaHash = input.userAgent ? sha256(input.userAgent).slice(0, 32) : null;
    const first = editor.first_claimed_at === null;
    const newDevice =
      !first &&
      ((ipHash !== null && editor.last_ip_hash !== null && ipHash !== editor.last_ip_hash) ||
        (uaHash !== null && editor.last_ua_hash !== null && uaHash !== editor.last_ua_hash));
    const at = new Date(now).toISOString();
    const updated = await store.update('event_editors', organizationId, editor.id, {
      first_claimed_at: editor.first_claimed_at ?? at,
      last_used_at: at,
      last_ip_hash: ipHash,
      last_ua_hash: uaHash,
      use_count: editor.use_count + 1,
    });
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'event.editor_link_claimed',
      entityType: 'event',
      entityId: event.id,
      metadata: {
        editorId: editor.id,
        label: editor.label,
        role: editor.role,
        first,
        newDevice,
      },
      ip: input.ip,
    });
    const cookieValue = sealCookie({
      g: editor.id,
      o: organizationId,
      e: event.id,
      v: editor.token_version,
      x: now + maxAgeSeconds * 1000,
    });
    return ok({ grant: grantOf(updated ?? editor, event), cookieValue, maxAgeSeconds });
  } catch (error) {
    return guardMissing(error, 'claimGrant');
  }
}

/* ------------------------------------------------------------ op scope */

export interface EnforceOptions {
  /** From the block registry (WS2): props outsiders may not set. */
  isOwnerOnlyProp?: (type: BlockType, key: string) => boolean;
  /** A block's default props (WS2's registry when omitted). */
  defaultProps?: (type: BlockType) => SectionProps;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The `authorize` hook for merge.ts: refuse ops outside the actor's
 * capabilities. Composes capabilities.ts's checkOp, plus one rule of its
 * own: a section an outsider INSERTS may carry owner-only props (RSVP form
 * wiring) only at the block's defaults, so a new section cannot smuggle in
 * wiring its author could not set by update.
 */
export function enforceOpScope(
  caps: EventCapabilities,
  options: EnforceOptions = {},
): (op: DraftOp, doc: EventDoc) => OpConflict | null {
  const isOwnerOnlyProp = options.isOwnerOnlyProp ?? blockRegistry.isOwnerOnlyProp;
  const defaultProps =
    options.defaultProps ?? ((type: BlockType) => blockRegistry.get(type)?.defaults().props ?? {});
  return (op, doc) => {
    let denied = checkOp(caps, op, {
      sectionType: (id) => doc.sections.find((s) => s.id === id)?.type ?? null,
      isOwnerOnlyProp,
    });
    if (!denied && op.kind === 'section.insert' && !caps.editOwnerOnlyProps) {
      const defaults = defaultProps(op.section.type);
      const smuggled = Object.keys(op.section.props).filter(
        (key) =>
          isOwnerOnlyProp(op.section.type, key) && !sameJson(op.section.props[key], defaults[key]),
      );
      if (smuggled.length) {
        denied = {
          reason: 'Only TipTop can change this',
          keys: smuggled.map((k) => `props.${k}`),
        };
      }
    }
    if (!denied) return null;
    const sectionId = 'id' in op ? op.id : op.kind === 'section.insert' ? op.section.id : null;
    return {
      opId: op.opId,
      kind: 'forbidden',
      target: op.kind === 'theme.update' ? 'theme' : op.kind === 'page.update' ? 'meta' : 'section',
      sectionId,
      keys: denied.keys,
      theirs: {},
      by: null,
      message: denied.reason,
    };
  };
}
