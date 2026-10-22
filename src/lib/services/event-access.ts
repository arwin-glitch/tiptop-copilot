import 'server-only';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { ownerCapabilities, type EventCapabilities } from '@/lib/events/capabilities';
import type { EventActor } from '@/lib/events/contracts';
import { parseEventDoc, type EventDoc, type ParseOptions } from '@/lib/events/schema';
import { log } from '@/lib/security/redact';
import type { EventDocJson } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Shared plumbing for the WS1 event services (events.ts, event-versions.ts,
 * event-media.ts): who may do what to one event, reading a stored document,
 * and turning a missing table into a plain "run the migration" answer.
 *
 * Every service takes an EventActor and asks `capabilitiesFor` first. An
 * outside link is for ONE event: any other event id looks like nothing at all
 * (not_found, never forbidden), so a link holder cannot probe for events.
 */

export const EVENTS_MIGRATION_FILE = 'supabase/migrations/20261023000000_events.sql';

const NOT_SET_UP = `Events are not set up yet: the events tables do not exist. Run ${EVENTS_MIGRATION_FILE} in the Supabase SQL editor, then reload.`;

export const NOT_FOUND_MESSAGE = 'That event does not exist.';

export function notFound<T>(): Result<T> {
  return err('not_found', NOT_FOUND_MESSAGE);
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '23505' || (typeof message === 'string' && /duplicate key value/i.test(message));
}

/**
 * Run a service body: a missing table or column becomes `not_configured`
 * with the fix, a unique violation `conflict`, anything else a logged
 * `internal` — never a throw out of a service.
 */
export async function guard<T>(
  operation: string,
  run: () => Promise<Result<T>>,
  messages: { conflict?: string; internal?: string } = {},
): Promise<Result<T>> {
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
      return err('conflict', messages.conflict ?? 'That link is already taken. Try another.', {
        details: { operation },
      });
    }
    log.error('Event operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', messages.internal ?? 'Events could not be read just now.', {
      retryable: true,
      details: { operation },
    });
  }
}

/** The capabilities an actor has on one event, or a refusal that reveals nothing. */
export function capabilitiesFor(actor: EventActor, eventId: string): Result<EventCapabilities> {
  if (actor.kind === 'owner') return ok(ownerCapabilities());
  if (actor.grant.eventId !== eventId) return notFound();
  return ok(actor.grant.capabilities);
}

/** The user id to put on an audit row: owners only (links have none). */
export function auditUserId(actor: EventActor): string | null {
  return actor.kind === 'owner' ? actor.userId : null;
}

/** A stored page, upgraded and validated, or a plain error naming the fix. */
export function readStoredDoc(
  raw: EventDocJson | null,
  context: { eventId: string; what: string },
  options: ParseOptions = {},
): Result<EventDoc> {
  const parsed = parseEventDoc(raw, options);
  if (parsed.ok) return ok(parsed.value);
  log.error('A stored event page failed validation', {
    event: context.eventId,
    what: context.what,
    issue: parsed.issues[0] ?? '',
  });
  return err(
    'internal',
    'This event page could not be read. Restore an earlier version from History.',
  );
}

/** Plain text for a stored label: control characters out, trimmed, capped. */
export function cleanText(value: string, max: number): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.trim().slice(0, max);
}
