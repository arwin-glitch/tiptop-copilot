import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { checkOp, type EventCapabilities } from '@/lib/events/capabilities';
import { GRANT_COOKIE, type EventGrant } from '@/lib/events/contracts';
import type { DraftOp, OpConflict } from '@/lib/events/ops';
import type { BlockType, EventDoc } from '@/lib/events/schema';
import type { EventEditorRole } from '@/lib/types/domain';
import { err, type Result } from '@/lib/util/result';

/**
 * CONTRACT STUB — owned by WS3 (Studio and collaboration). Replace the
 * bodies, keep the exports and signatures.
 *
 *   resolveGrant   the tiptop_ev_grant cookie → a live EventGrant, re-checking
 *                  revoked_at, expires_at, token_version, editing_paused,
 *                  the event and the role on EVERY request. Unknown, expired
 *                  or revoked: a generic not_found (never say which).
 *   claimGrant     the POSTed #k= secret → the grant, a signed cookie value
 *                  (signedValue({grantId, tokenVersion, exp})) and its max age
 *                  (12 h sliding, never past the grant's expiry). Rate-limited
 *                  per address bucket (10 per 10 min).
 *   enforceOpScope the per-op capability check WS1's ops service passes to
 *                  merge.ts as `authorize`. Working now (it composes
 *                  capabilities.ts's checkOp); WS3 may refine.
 *
 * Until WS3 lands, every link resolves to nothing: outsiders get no access
 * at all, which is the safe failure.
 */

export { GRANT_COOKIE };

export interface ResolveGrantInput {
  eventId: string;
  /** The raw tiptop_ev_grant cookie value. */
  cookieValue: string | null | undefined;
  /** Roles this route accepts (e.g. ['checkin'] for the door list). */
  roles?: readonly EventEditorRole[];
}

export async function resolveGrant(
  store: DataStore,
  input: ResolveGrantInput,
): Promise<Result<EventGrant>> {
  void store;
  void input;
  return err('not_found', 'This link is not valid.');
}

export interface ClaimGrantInput {
  /** The 43-character secret from the link's #k= fragment, POSTed by an explicit click. */
  token: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ClaimedGrant {
  grant: EventGrant;
  /** Value for the httpOnly, Secure, SameSite=Strict tiptop_ev_grant cookie. */
  cookieValue: string;
  maxAgeSeconds: number;
}

export async function claimGrant(
  store: DataStore,
  input: ClaimGrantInput,
): Promise<Result<ClaimedGrant>> {
  void store;
  void input;
  return err('not_found', 'This link is not valid.');
}

export interface EnforceOptions {
  /** From the block registry (WS2): props outsiders may not set. */
  isOwnerOnlyProp?: (type: BlockType, key: string) => boolean;
}

/** The `authorize` hook for merge.ts: refuse ops outside the actor's capabilities. */
export function enforceOpScope(
  caps: EventCapabilities,
  options: EnforceOptions = {},
): (op: DraftOp, doc: EventDoc) => OpConflict | null {
  return (op, doc) => {
    const denied = checkOp(caps, op, {
      sectionType: (id) => doc.sections.find((s) => s.id === id)?.type ?? null,
      isOwnerOnlyProp: options.isOwnerOnlyProp,
    });
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
