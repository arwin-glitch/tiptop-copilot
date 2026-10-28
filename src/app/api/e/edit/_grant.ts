import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type { DataStore } from '@/lib/db/store';
import type { EventActor } from '@/lib/events/contracts';
import {
  GRANT_COOKIE,
  appendGrantCookies,
  grantCookies,
  resolveGrantSession,
  type GrantSession,
} from '@/lib/events/editor-auth';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError, type Result } from '@/lib/util/result';

/**
 * Shared by the outside editor's API (/api/e/edit/[eventId]/**). Never a
 * Kraken session: each request resolves the path-scoped tiptop_ev_grant
 * cookie and re-checks the link (lib/events/editor-auth.ts), then calls the
 * same narrow services as owners with a grant actor, whose capabilities
 * the services enforce. Any failure to resolve is one generic 404.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export const grantFail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: NO_STORE },
  );

export const notValid = () =>
  grantFail({ code: 'not_found', message: 'This link is not valid.' }, 404);

export interface GrantGate {
  ok: true;
  store: DataStore;
  session: GrantSession;
  actor: EventActor;
  eventId: string;
}

/** Resolve and re-check the link for this event, within a per-link rate limit. */
export async function grantGate(
  request: NextRequest,
  eventId: string,
  limit: { bucket: string; max: number; windowMs?: number },
): Promise<GrantGate | { ok: false; response: NextResponse }> {
  if (!ID_RE.test(eventId)) return { ok: false, response: notValid() };
  const store = getStore();
  const session = await resolveGrantSession(store, {
    eventId,
    cookieValue: request.cookies.get(GRANT_COOKIE)?.value,
  });
  if (!session.ok) return { ok: false, response: notValid() };
  const limited = rateLimit(
    `event-grant-${limit.bucket}:${session.value.grant.grantId}`,
    limit.max,
    limit.windowMs ?? 60_000,
  );
  if (!limited.ok) return { ok: false, response: grantFail(limited.error) };
  const grant = session.value.grant;
  return {
    ok: true,
    store,
    session: session.value,
    actor: { kind: 'grant', grant, name: grant.label },
    eventId,
  };
}

/** A JSON answer, re-issuing the sliding session cookie when it runs low. */
export function grantDone(gate: GrantGate, value: Record<string, unknown>): NextResponse {
  const response = NextResponse.json({ ok: true, ...value }, { headers: NO_STORE });
  const refresh = gate.session.refresh;
  if (refresh) {
    appendGrantCookies(
      response.headers,
      grantCookies(gate.session.grant.role, gate.eventId, refresh.value, refresh.maxAgeSeconds),
    );
  }
  return response;
}

export function grantRespond<T>(
  gate: GrantGate,
  result: Result<T>,
  shape: (value: T) => Record<string, unknown>,
): NextResponse {
  if (result.ok) return grantDone(gate, shape(result.value));
  // A link that stops resolving mid-request reads like any other bad link.
  if (result.error.code === 'not_found') return notValid();
  return grantFail(result.error);
}

/** Read a JSON body with a byte cap; null when it is missing, too large or not JSON. */
export async function readJson(request: NextRequest, maxBytes: number): Promise<unknown | null> {
  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > maxBytes) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
