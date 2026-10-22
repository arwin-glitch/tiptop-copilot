import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  capacityViolations,
  planIsEmpty,
  rowsAfterPlan,
  type EngineContext,
  type RegistrationPlan,
} from '@/lib/events/capacity';
import { log } from '@/lib/security/redact';
import type { EventGuest, EventRecord, EventSession } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Applying a RegistrationPlan (lib/events/capacity.ts) atomically (D-075).
 *
 *   Supabase: the event_register() SQL function
 *             (supabase/migrations/20261023000200_event_register_fn.sql)
 *             locks the event and its sessions FOR UPDATE, applies the plan
 *             and refuses it whole if it would exceed capacity.
 *   Demo:     the same invariant (capacityViolations) checked and applied
 *             under a per-event in-process lock, so the demo store — and the
 *             tests, which run on it — get the same guarantee.
 *
 * `runPlanned` is the loop every seat-taking change uses: read the event's
 * rows, plan, apply; when the apply says "capacity" (someone else took the
 * seat in between), read again and re-plan, up to three times.
 */

export const REGISTER_MIGRATION_FILE = 'supabase/migrations/20261023000200_event_register_fn.sql';
export const PLAN_ATTEMPTS = 3;

export type ApplyFailure =
  'capacity' | 'duplicate_email' | 'not_found' | 'invalid' | 'not_configured';
export type ApplyResult = { ok: true } | { ok: false; reason: ApplyFailure };

/* ------------------------------------------------------------ demo lock */

const locks = processWide('event-register-locks', () => new Map<string, Promise<void>>());

/** Run `fn` with no other planned write for this event in flight (this process). */
export async function withEventLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(eventId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => mine);
  locks.set(eventId, chained);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(eventId) === chained) locks.delete(eventId);
  }
}

/* --------------------------------------------------------------- loading */

export interface LoadedEvent {
  event: EventRecord;
  sessions: EventSession[];
  guests: EventGuest[];
  rows: EngineContext['rows'];
}

/** Everything a plan is computed from: the event, its sessions, guests and status rows. */
export async function loadEngineState(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<LoadedEvent | null> {
  const event = await store.get('events', organizationId, eventId);
  if (!event) return null;
  const [sessions, guests, rows] = await Promise.all([
    store.list(
      'event_sessions',
      organizationId,
      { eq: { event_id: eventId } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    ),
    store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
    store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
  ]);
  return { event, sessions, guests, rows };
}

export function engineContext(loaded: LoadedEvent, now: Date = new Date()): EngineContext {
  return {
    event: {
      id: loaded.event.id,
      organization_id: loaded.event.organization_id,
      access: loaded.event.access,
      capacity: loaded.event.capacity,
      registration: loaded.event.registration,
    },
    sessions: loaded.sessions,
    guests: loaded.guests,
    rows: loaded.rows,
    now: now.toISOString(),
    newId,
  };
}

/* -------------------------------------------------------------- applying */

let rpcClient: SupabaseClient | null = null;

function supabaseRpc(): SupabaseClient | null {
  if (rpcClient) return rpcClient;
  const e = env();
  if (!e.supabaseUrl || !e.supabaseServiceRoleKey) return null;
  rpcClient = createClient(e.supabaseUrl, e.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return rpcClient;
}

/** The demo store's event_register(): same checks, under the event lock (the caller holds it). */
async function applyInStore(
  store: DataStore,
  organizationId: string,
  eventId: string,
  plan: RegistrationPlan,
): Promise<ApplyResult> {
  const [event, sessions, guests, rows] = await Promise.all([
    store.get('events', organizationId, eventId),
    store.list('event_sessions', organizationId, { eq: { event_id: eventId } }),
    store.list('event_guests', organizationId, { eq: { event_id: eventId } }),
    store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } }),
  ]);
  if (!event) return { ok: false, reason: 'not_found' };
  const guestIds = new Set(guests.map((g) => g.id));
  const sessionIds = new Set(sessions.map((s) => s.id));
  const plannedIds = new Set(plan.upsertGuests.map((g) => g.id));

  // Rows must stay inside the event.
  for (const g of plan.upsertGuests) {
    if (g.organization_id !== organizationId || g.event_id !== eventId) {
      return { ok: false, reason: 'invalid' };
    }
    if (
      g.parent_guest_id &&
      !guestIds.has(g.parent_guest_id) &&
      !plannedIds.has(g.parent_guest_id)
    ) {
      return { ok: false, reason: 'invalid' };
    }
  }
  for (const r of plan.upsertRows) {
    if (
      !sessionIds.has(r.session_id) ||
      (!guestIds.has(r.guest_id) && !plannedIds.has(r.guest_id))
    ) {
      return { ok: false, reason: 'invalid' };
    }
  }
  // unique (event_id, email)
  const deleting = new Set(plan.deleteGuestIds);
  const emails = new Map<string, string>();
  for (const g of guests) if (g.email && !deleting.has(g.id)) emails.set(g.email, g.id);
  for (const g of plan.upsertGuests) {
    if (!g.email) continue;
    const holder = emails.get(g.email);
    if (holder && holder !== g.id) return { ok: false, reason: 'duplicate_email' };
    emails.set(g.email, g.id);
  }
  // Capacity.
  if (!plan.force) {
    const removedGuests = new Set<string>(plan.deleteGuestIds);
    // Cascade: plus-ones of a removed guest go too.
    for (const g of guests)
      if (g.parent_guest_id && removedGuests.has(g.parent_guest_id)) removedGuests.add(g.id);
    const after = rowsAfterPlan(rows, { ...plan, deleteGuestIds: [...removedGuests] });
    if (capacityViolations(rows, after, sessions, event.capacity).length) {
      return { ok: false, reason: 'capacity' };
    }
  }

  // Apply.
  const toDelete = new Set(plan.deleteGuestIds);
  for (const g of guests)
    if (g.parent_guest_id && toDelete.has(g.parent_guest_id)) toDelete.add(g.id);
  for (const id of toDelete) {
    await store.removeWhere('event_guest_sessions', organizationId, { eq: { guest_id: id } });
    await store.removeWhere('event_guests', organizationId, { eq: { id, event_id: eventId } });
  }
  const byId = new Map(guests.map((g) => [g.id, g]));
  const ordered = [...plan.upsertGuests].sort(
    (a, b) => Number(Boolean(a.parent_guest_id)) - Number(Boolean(b.parent_guest_id)),
  );
  for (const g of ordered) {
    const existing = byId.get(g.id);
    if (existing && !toDelete.has(g.id)) {
      await store.update('event_guests', organizationId, g.id, {
        email: g.email,
        first_name: g.first_name,
        last_name: g.last_name,
        company: g.company,
        title: g.title,
        phone: g.phone,
        record_id: g.record_id,
        tags: g.tags,
        answers: g.answers,
        show_on_wall: g.show_on_wall,
        registered_at: g.registered_at,
      });
    } else {
      await store.insert('event_guests', {
        ...g,
        organization_id: organizationId,
        event_id: eventId,
      });
    }
  }
  for (const d of plan.deleteRows) {
    await store.removeWhere('event_guest_sessions', organizationId, {
      eq: { guest_id: d.guest_id, session_id: d.session_id },
    });
  }
  const current = new Map(rows.map((r) => [`${r.guest_id}|${r.session_id}`, r]));
  for (const r of plan.upsertRows) {
    const was = current.get(`${r.guest_id}|${r.session_id}`);
    await store.upsert(
      'event_guest_sessions',
      {
        ...r,
        organization_id: organizationId,
        event_id: eventId,
        checked_in_at: r.checked_in_at ?? was?.checked_in_at ?? null,
        checked_in_by: r.checked_in_by ?? was?.checked_in_by ?? null,
      },
      ['guest_id', 'session_id'],
    );
  }
  return { ok: true };
}

/** Apply one plan atomically. */
export async function applyPlan(
  store: DataStore,
  organizationId: string,
  eventId: string,
  plan: RegistrationPlan,
): Promise<ApplyResult> {
  if (planIsEmpty(plan)) return { ok: true };
  if (store.kind === 'demo') return applyInStore(store, organizationId, eventId, plan);
  const client = supabaseRpc();
  if (!client) return { ok: false, reason: 'not_configured' };
  const { data, error } = await client.rpc('event_register', {
    p_organization_id: organizationId,
    p_event_id: eventId,
    p_plan: plan,
  });
  if (error) {
    if (
      /function .*event_register.* does not exist|PGRST202/i.test(`${error.code} ${error.message}`)
    ) {
      return { ok: false, reason: 'not_configured' };
    }
    throw Object.assign(new Error(`event_register: ${error.message}`), {
      code: error.code ?? null,
    });
  }
  const result = data as { ok?: unknown; reason?: unknown } | null;
  if (result?.ok === true) return { ok: true };
  const reason = typeof result?.reason === 'string' ? result.reason : 'invalid';
  if (reason === 'capacity' || reason === 'duplicate_email' || reason === 'not_found') {
    return { ok: false, reason };
  }
  log.error('event_register refused a plan', { reason });
  return { ok: false, reason: 'invalid' };
}

/* ------------------------------------------------------------ the loop */

export type Planned<T> =
  { kind: 'plan'; plan: RegistrationPlan; value: T } | { kind: 'stop'; result: Result<T> };

const NOT_SET_UP = `Events are not set up yet. Run the events migrations (ending with ${REGISTER_MIGRATION_FILE}) in the Supabase SQL editor.`;

/**
 * Read → plan → apply, re-planning when someone else took the seat in
 * between. `build` returns the plan and the value to hand back once it is
 * applied, or a final result (e.g. "already registered").
 */
export async function runPlanned<T>(
  store: DataStore,
  organizationId: string,
  eventId: string,
  build: (loaded: LoadedEvent, now: Date) => Planned<T> | Promise<Planned<T>>,
  options: { onDuplicateEmail?: () => Result<T> } = {},
): Promise<Result<T>> {
  try {
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
      const once = async (): Promise<{ done: Result<T> } | { retry: true }> => {
        const loaded = await loadEngineState(store, organizationId, eventId);
        if (!loaded) return { done: err('not_found', 'That event does not exist.') };
        const planned = await build(loaded, new Date());
        if (planned.kind === 'stop') return { done: planned.result };
        const applied = await applyPlan(store, organizationId, eventId, planned.plan);
        if (applied.ok) return { done: ok(planned.value) };
        if (applied.reason === 'capacity') return { retry: true };
        if (applied.reason === 'duplicate_email') {
          return {
            done:
              options.onDuplicateEmail?.() ??
              err('conflict', 'Someone with that email is already on the list.'),
          };
        }
        if (applied.reason === 'not_found')
          return { done: err('not_found', 'That event does not exist.') };
        if (applied.reason === 'not_configured') {
          return { done: err('not_configured', NOT_SET_UP) };
        }
        return {
          done: err('internal', 'That change could not be saved. Try again.', { retryable: true }),
        };
      };
      const outcome = store.kind === 'demo' ? await withEventLock(eventId, once) : await once();
      if ('done' in outcome) return outcome.done;
    }
    return err('conflict', 'A lot of people are responding right now. Try again in a moment.', {
      retryable: true,
    });
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return err('not_configured', NOT_SET_UP);
    }
    log.error('Event registration write failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'That change could not be saved. Try again.', { retryable: true });
  }
}
