import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  GRANT_DEFAULT_EXPIRY_DAYS,
  GRANT_EXPIRY_DAYS,
  GRANT_MAX_EXPIRY_DAYS,
  eventPaths,
  type EventGrant,
} from '@/lib/events/contracts';
import { hashGrantSecret } from '@/lib/events/editor-auth';
import { ID_RE, parseEventDoc } from '@/lib/events/schema';
import { recordAudit } from '@/lib/security/audit';
import { randomToken } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type {
  AuditEvent,
  EventEditor,
  EventEditorRole,
  EventEditorScope,
  EventRecord,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import type { EventOwner } from './events';

/**
 * Outside links, the owners' side (D-075): create, list, change, regenerate,
 * revoke, revoke all, pause editing, and the notices owners get about them.
 * The claim and the per-request check live in lib/events/editor-auth.ts.
 *
 * One link per person, never a shared "anyone can edit" link. A link is shown
 * ONCE, at creation or regeneration: only its SHA-256 and a 4-character hint
 * are kept. Roles: editor (the page design and content of this one event,
 * within a scope), viewer (read-only draft preview) and checkin (the door
 * list, WS4). No link reaches guests, answers, messages, analytics, settings,
 * sharing, versions, publishing or any other Kraken page.
 *
 * Nothing here sends anything: "Draft an email" in the Sharing panel opens a
 * draft in the owner's own mail app, never sends.
 */

export const LABEL_MAX = 80;
export const EMAIL_MAX = 320;
/** "Event end + 2 days" expiry. */
export const EVENT_END_GRACE_DAYS = 2;
/** Links an event may hold at once (live or not), as a brake. */
export const MAX_LINKS_PER_EVENT = 100;
/** "Ready for review" clicks per link per hour. */
export const REVIEW_LIMIT_PER_HOUR = 6;

export type EditorLinkStatus = 'active' | 'unused' | 'expired' | 'revoked';

/** A link as the Sharing panel lists it: never its hash. */
export interface EditorLinkSummary {
  id: string;
  label: string;
  email: string | null;
  role: EventEditorRole;
  scope: EventEditorScope;
  hint: string;
  status: EditorLinkStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstClaimedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

/** A link just made or regenerated: the secret travels to the owner once. */
export interface IssuedEditorLink {
  link: EditorLinkSummary;
  /** App-relative: /e/edit#k=<secret> (or /e/checkin#k=… for staff). */
  path: string;
}

export type ExpiryChoice = { days: number } | { eventEnd: true };

export interface CreateEditorLinkInput {
  label: string;
  email?: string | null;
  role: EventEditorRole;
  scope?: Partial<EventEditorScope>;
  expiry?: ExpiryChoice;
}

export interface UpdateEditorLinkInput {
  label?: string;
  email?: string | null;
  scope?: Partial<EventEditorScope>;
  expiry?: ExpiryChoice;
}

/* ---------------------------------------------------------------- helpers */

const NOT_SET_UP =
  'Outside links are not set up yet: the events tables do not exist. Run supabase/migrations/20261023000000_events.sql, then reload.';

async function guard<T>(operation: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP, {
        stillUsable: 'Everything else in Kraken works as before.',
        details: { operation },
      });
    }
    log.error('Outside link operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Outside links could not be changed just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

export function linkStatus(editor: EventEditor, now: number = Date.now()): EditorLinkStatus {
  if (editor.revoked_at) return 'revoked';
  if (Date.parse(editor.expires_at) <= now) return 'expired';
  return editor.first_claimed_at ? 'active' : 'unused';
}

export function summarizeLink(editor: EventEditor, now: number = Date.now()): EditorLinkSummary {
  return {
    id: editor.id,
    label: editor.label,
    email: editor.email,
    role: editor.role,
    scope: editor.scope,
    hint: editor.token_hint,
    status: linkStatus(editor, now),
    createdAt: editor.created_at,
    expiresAt: editor.expires_at,
    revokedAt: editor.revoked_at,
    firstClaimedAt: editor.first_claimed_at,
    lastUsedAt: editor.last_used_at,
    useCount: editor.use_count,
  };
}

function entryPath(role: EventEditorRole, secret: string): string {
  return role === 'checkin' ? eventPaths.staffEntry(secret) : eventPaths.editEntry(secret);
}

const ROLES: readonly EventEditorRole[] = ['editor', 'viewer', 'checkin'];

function cleanLabel(label: unknown): Result<string> {
  const value = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim() : '';
  if (value.length < 1 || value.length > LABEL_MAX) {
    return err(
      'invalid_input',
      `Give the link a name, like "Morgan – Example Partners" (up to ${LABEL_MAX} characters).`,
    );
  }
  return ok(value);
}

function cleanEmail(email: unknown): Result<string | null> {
  if (email === undefined || email === null || email === '') return ok(null);
  if (typeof email !== 'string') return err('invalid_input', 'That email address is not valid.');
  const value = email.trim().toLowerCase();
  if (value.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return err('invalid_input', 'That email address is not valid.');
  }
  return ok(value);
}

/**
 * The scope a link gets. Viewer and staff links never edit. Section lists
 * keep only sections that exist in the draft (at least one), and brand lock
 * is on unless explicitly turned off.
 */
function cleanScope(
  role: EventEditorRole,
  input: Partial<EventEditorScope> | undefined,
  event: EventRecord,
  base?: EventEditorScope,
): Result<EventEditorScope> {
  if (role !== 'editor') {
    return ok({ design: false, content: false, sections: 'all', brand_locked: true });
  }
  const merged = {
    design: base?.design ?? false,
    content: base?.content ?? true,
    sections: base?.sections ?? ('all' as const),
    brand_locked: base?.brand_locked ?? true,
    ...(input ?? {}),
  };
  if (typeof merged.design !== 'boolean' || typeof merged.content !== 'boolean') {
    return err('invalid_input', 'Choose what this editor may change.');
  }
  if (!merged.design && !merged.content) {
    return err(
      'invalid_input',
      'An editor link needs design, content or both. Use a viewer link to share a preview.',
    );
  }
  let sections: EventEditorScope['sections'] = 'all';
  if (merged.sections !== 'all') {
    if (!Array.isArray(merged.sections) || merged.sections.length > 60) {
      return err('invalid_input', 'Choose the sections this editor may change.');
    }
    const parsed = parseEventDoc(event.draft_doc);
    const existing = new Set(parsed.ok ? parsed.value.sections.map((s) => s.id) : []);
    const chosen = [
      ...new Set(
        merged.sections.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)),
      ),
    ].filter((id) => existing.has(id));
    if (!chosen.length) return err('invalid_input', 'Choose at least one section.');
    sections = chosen;
  }
  return ok({
    design: merged.design,
    content: merged.content,
    sections,
    brand_locked: merged.brand_locked !== false,
  });
}

/** When a link expires: 3/7/14/30/90 days, or the event's end + 2 days, never past 90 days. */
export function expiryFor(
  choice: ExpiryChoice | undefined,
  event: Pick<EventRecord, 'starts_at' | 'ends_at'>,
  now: number = Date.now(),
): Result<string> {
  const cap = now + GRANT_MAX_EXPIRY_DAYS * 86_400_000;
  if (!choice || 'days' in choice) {
    const days = choice?.days ?? GRANT_DEFAULT_EXPIRY_DAYS;
    if (!(GRANT_EXPIRY_DAYS as readonly number[]).includes(days)) {
      return err('invalid_input', 'Choose an expiry of 3, 7, 14, 30 or 90 days.');
    }
    return ok(new Date(Math.min(cap, now + days * 86_400_000)).toISOString());
  }
  const end = event.ends_at ?? event.starts_at;
  if (!end) return err('invalid_input', 'This event has no date yet, so choose a number of days.');
  const at = Date.parse(end) + EVENT_END_GRACE_DAYS * 86_400_000;
  if (!(at > now + 3_600_000)) {
    return err('invalid_input', 'The event has already ended, so choose a number of days.');
  }
  return ok(new Date(Math.min(cap, at)).toISOString());
}

async function eventOf(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<EventRecord | null> {
  return store.get('events', organizationId, eventId);
}

async function linkOf(
  store: DataStore,
  organizationId: string,
  eventId: string,
  linkId: string,
): Promise<EventEditor | null> {
  if (!ID_RE.test(linkId)) return null;
  const editor = await store.get('event_editors', organizationId, linkId);
  return editor && editor.event_id === eventId ? editor : null;
}

function newSecret(): { secret: string; tokenHash: string; hint: string } {
  const secret = randomToken(32);
  return { secret, tokenHash: hashGrantSecret(secret), hint: secret.slice(-4) };
}

/* ------------------------------------------------------------------ links */

export async function listEditorLinks(
  store: DataStore,
  organizationId: string,
  eventId: string,
  now: number = Date.now(),
): Promise<Result<EditorLinkSummary[]>> {
  return guard('listEditorLinks', async () => {
    const rows = await store.list(
      'event_editors',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: MAX_LINKS_PER_EVENT },
    );
    return ok(rows.map((r) => summarizeLink(r, now)));
  });
}

export async function createEditorLink(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  input: CreateEditorLinkInput,
  now: number = Date.now(),
): Promise<Result<IssuedEditorLink>> {
  const label = cleanLabel(input.label);
  if (!label.ok) return label;
  const email = cleanEmail(input.email);
  if (!email.ok) return email;
  if (!ROLES.includes(input.role))
    return err('invalid_input', 'Choose editor, viewer or check-in.');
  return guard('createEditorLink', async () => {
    const event = await eventOf(store, owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const count = await store.count('event_editors', owner.organizationId, {
      eq: { event_id: eventId },
    });
    if (count >= MAX_LINKS_PER_EVENT) {
      return err('invalid_input', 'This event has too many links. Revoke some first.');
    }
    const scope = cleanScope(input.role, input.scope, event);
    if (!scope.ok) return scope;
    const expiresAt = expiryFor(input.expiry, event, now);
    if (!expiresAt.ok) return expiresAt;
    const { secret, tokenHash, hint } = newSecret();
    const at = new Date(now).toISOString();
    const row: EventEditor = {
      id: newId(),
      organization_id: owner.organizationId,
      event_id: eventId,
      label: label.value,
      email: email.value,
      role: input.role,
      scope: scope.value,
      token_hash: tokenHash,
      token_hint: hint,
      token_version: 1,
      password_hash: null,
      expires_at: expiresAt.value,
      revoked_at: null,
      created_by: owner.userId,
      created_at: at,
      first_claimed_at: null,
      last_used_at: null,
      last_ip_hash: null,
      last_ua_hash: null,
      use_count: 0,
    };
    await store.insert('event_editors', row);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.editor_link_created',
      entityType: 'event',
      entityId: eventId,
      metadata: { editorId: row.id, role: row.role, label: row.label, expiresAt: row.expires_at },
    });
    return ok({ link: summarizeLink(row, now), path: entryPath(row.role, secret) });
  });
}

export async function updateEditorLink(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  linkId: string,
  input: UpdateEditorLinkInput,
  now: number = Date.now(),
): Promise<Result<EditorLinkSummary>> {
  return guard('updateEditorLink', async () => {
    const [event, editor] = await Promise.all([
      eventOf(store, owner.organizationId, eventId),
      linkOf(store, owner.organizationId, eventId, linkId),
    ]);
    if (!event || !editor) return err('not_found', 'That link does not exist.');
    if (editor.revoked_at) return err('conflict', 'That link was revoked. Make a new one instead.');
    const patch: Partial<EventEditor> = {};
    if (input.label !== undefined) {
      const label = cleanLabel(input.label);
      if (!label.ok) return label;
      patch.label = label.value;
    }
    if (input.email !== undefined) {
      const email = cleanEmail(input.email);
      if (!email.ok) return email;
      patch.email = email.value;
    }
    if (input.scope !== undefined) {
      const scope = cleanScope(editor.role, input.scope, event, editor.scope);
      if (!scope.ok) return scope;
      patch.scope = scope.value;
    }
    if (input.expiry !== undefined) {
      const expiresAt = expiryFor(input.expiry, event, now);
      if (!expiresAt.ok) return expiresAt;
      patch.expires_at = expiresAt.value;
    }
    if (!Object.keys(patch).length) return ok(summarizeLink(editor, now));
    const updated = await store.update('event_editors', owner.organizationId, editor.id, patch);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.editor_link_updated',
      entityType: 'event',
      entityId: eventId,
      metadata: { editorId: editor.id, changed: Object.keys(patch).join(',') },
    });
    return ok(summarizeLink(updated, now));
  });
}

/**
 * A new secret for the same person: the old link stops working and every
 * session claimed with it ends on its next request (token_version bump).
 */
export async function regenerateEditorLink(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  linkId: string,
  now: number = Date.now(),
): Promise<Result<IssuedEditorLink>> {
  return guard('regenerateEditorLink', async () => {
    const editor = await linkOf(store, owner.organizationId, eventId, linkId);
    if (!editor) return err('not_found', 'That link does not exist.');
    if (editor.revoked_at) return err('conflict', 'That link was revoked. Make a new one instead.');
    if (Date.parse(editor.expires_at) <= now) {
      return err('conflict', 'That link has expired. Extend it first, or make a new one.');
    }
    const { secret, tokenHash, hint } = newSecret();
    const updated = await store.update('event_editors', owner.organizationId, editor.id, {
      token_hash: tokenHash,
      token_hint: hint,
      token_version: editor.token_version + 1,
      first_claimed_at: null,
      last_ip_hash: null,
      last_ua_hash: null,
    });
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.editor_link_regenerated',
      entityType: 'event',
      entityId: eventId,
      metadata: { editorId: editor.id, label: editor.label },
    });
    return ok({ link: summarizeLink(updated, now), path: entryPath(updated.role, secret) });
  });
}

export async function revokeEditorLink(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  linkId: string,
  now: number = Date.now(),
): Promise<Result<EditorLinkSummary>> {
  return guard('revokeEditorLink', async () => {
    const editor = await linkOf(store, owner.organizationId, eventId, linkId);
    if (!editor) return err('not_found', 'That link does not exist.');
    if (editor.revoked_at) return ok(summarizeLink(editor, now));
    const updated = await store.update('event_editors', owner.organizationId, editor.id, {
      revoked_at: new Date(now).toISOString(),
    });
    await removeGrantPresence(store, owner.organizationId, eventId, editor.id);
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.editor_link_revoked',
      entityType: 'event',
      entityId: eventId,
      metadata: { editorId: editor.id, label: editor.label },
    });
    return ok(summarizeLink(updated, now));
  });
}

/** The panic button: every live link of the event (optionally of some roles) stops now. */
export async function revokeAllEditorLinks(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  roles: readonly EventEditorRole[] = ROLES,
  now: number = Date.now(),
): Promise<Result<{ revoked: number }>> {
  return guard('revokeAllEditorLinks', async () => {
    const event = await eventOf(store, owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    const live = (
      await store.list('event_editors', owner.organizationId, {
        eq: { event_id: eventId },
        isNull: ['revoked_at'],
      })
    ).filter((e) => roles.includes(e.role));
    const at = new Date(now).toISOString();
    for (const editor of live) {
      await store.update('event_editors', owner.organizationId, editor.id, { revoked_at: at });
      await removeGrantPresence(store, owner.organizationId, eventId, editor.id);
    }
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: 'event.editor_links_revoked_all',
      entityType: 'event',
      entityId: eventId,
      metadata: { count: live.length, roles: roles.join(',') },
    });
    return ok({ revoked: live.length });
  });
}

async function removeGrantPresence(
  store: DataStore,
  organizationId: string,
  eventId: string,
  grantId: string,
): Promise<void> {
  await store
    .removeWhere('event_presence', organizationId, {
      eq: { event_id: eventId, actor_key: `g:${grantId}` },
    })
    .catch(() => 0);
}

/**
 * Pause editing: the whole event goes read-only for outside editors (their
 * links keep working for viewing). Reversible.
 */
export async function setEditingPaused(
  store: DataStore,
  owner: EventOwner,
  eventId: string,
  paused: boolean,
): Promise<Result<{ editingPaused: boolean }>> {
  return guard('setEditingPaused', async () => {
    const event = await eventOf(store, owner.organizationId, eventId);
    if (!event) return err('not_found', 'That event does not exist.');
    if (event.editing_paused === paused) return ok({ editingPaused: paused });
    await store.update('events', owner.organizationId, eventId, {
      editing_paused: paused,
      updated_at: new Date().toISOString(),
    });
    await recordAudit(store, {
      organizationId: owner.organizationId,
      userId: owner.userId,
      action: paused ? 'event.editing_paused' : 'event.editing_resumed',
      entityType: 'event',
      entityId: eventId,
      metadata: {},
    });
    return ok({ editingPaused: paused });
  });
}

/* ---------------------------------------------------------------- notices */

/** An outside editor clicked "Ready for review" (owners get a notice and an alert). */
export async function markReadyForReview(
  store: DataStore,
  grant: EventGrant,
  note: string | null,
  ip: string | null = null,
): Promise<Result<{ at: string }>> {
  if (grant.role !== 'editor') return err('forbidden', 'Only editor links can ask for a review.');
  const limited = rateLimit(`event-review:${grant.grantId}`, REVIEW_LIMIT_PER_HOUR, 3_600_000);
  if (!limited.ok) return limited;
  const cleanNote = (note ?? '').replace(/\s+/g, ' ').trim().slice(0, 280) || null;
  return guard('markReadyForReview', async () => {
    const at = new Date().toISOString();
    await recordAudit(store, {
      organizationId: grant.organizationId,
      userId: null,
      action: 'event.ready_for_review',
      entityType: 'event',
      entityId: grant.eventId,
      metadata: { editorId: grant.grantId, label: grant.label, note: cleanNote },
      ip,
    });
    return ok({ at });
  });
}

export type EditorNoticeKind = 'first_claim' | 'new_device' | 'ready_for_review';

/** What owners are told about outside links (Today, Sharing, desktop and phone alerts). */
export interface EditorNotice {
  /** The audit row id: a stable key for alert ledgers. */
  id: string;
  kind: EditorNoticeKind;
  eventId: string;
  eventTitle: string | null;
  label: string;
  note: string | null;
  at: string;
}

export const NOTICE_ACTIONS = ['event.editor_link_claimed', 'event.ready_for_review'] as const;

/** The plain sentence a notice reads as. */
export function noticeSentence(notice: EditorNotice): string {
  const where = notice.eventTitle ? ` ${notice.eventTitle}` : ' the event page';
  switch (notice.kind) {
    case 'first_claim':
      return `${notice.label} opened their edit link for${where} for the first time`;
    case 'new_device':
      return `${notice.label} used their edit link for${where} from a new device or network`;
    case 'ready_for_review':
      return `${notice.label} marked${where} ready for review`;
  }
}

function noticeOf(row: AuditEvent, titles: Map<string, string>): EditorNotice | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const label = typeof meta.label === 'string' ? meta.label : 'An outside editor';
  const eventId = row.entity_id ?? '';
  let kind: EditorNoticeKind | null = null;
  if (row.action === 'event.ready_for_review') kind = 'ready_for_review';
  else if (row.action === 'event.editor_link_claimed') {
    kind = meta.first === true ? 'first_claim' : meta.newDevice === true ? 'new_device' : null;
  }
  if (!kind) return null;
  return {
    id: row.id,
    kind,
    eventId,
    eventTitle: titles.get(eventId) ?? null,
    label,
    note: typeof meta.note === 'string' ? meta.note : null,
    at: row.created_at,
  };
}

/**
 * Recent notices, newest first: first claims, use from a new device or
 * network, and "Ready for review". For the Sharing panel, Today and alerts.
 */
export async function listEditorNotices(
  store: DataStore,
  organizationId: string,
  options: { eventId?: string; since?: string; limit?: number } = {},
): Promise<Result<EditorNotice[]>> {
  return guard('listEditorNotices', async () => {
    const since = options.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = (await store.list(
      'audit_events',
      organizationId,
      {
        in: { action: [...NOTICE_ACTIONS] },
        gte: { created_at: since },
        ...(options.eventId ? { eq: { entity_id: options.eventId } } : {}),
      },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: options.limit ?? 50 },
    )) as AuditEvent[];
    const eventIds = [...new Set(rows.map((r) => r.entity_id).filter((id): id is string => !!id))];
    const titles = new Map<string, string>();
    for (const id of eventIds) {
      const event = await store.get('events', organizationId, id).catch(() => null);
      if (event) titles.set(id, event.title);
    }
    return ok(rows.map((r) => noticeOf(r, titles)).filter((n): n is EditorNotice => n !== null));
  });
}
