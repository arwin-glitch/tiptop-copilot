import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent } from '@/lib/types/domain';
import { log } from '@/lib/security/redact';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { CALENDAR_VIEWS, type CalendarViewKind } from '@/lib/calendar/range-types';

/**
 * Each person's Calendar tab settings: whether they use the new views (the
 * preview switch), which view they were last on, and the calendars they
 * turned on or off. No schema change: an `audit_events` row per change
 * (action `calendar.prefs_set`, newest per person wins), written directly
 * rather than through recordAudit, whose redaction would mangle calendar ids
 * that look like email addresses. A failed read is the defaults, never an
 * error page.
 */

export const CALENDAR_PREFS_ACTION = 'calendar.prefs_set';

export interface CalendarPrefs {
  /** On the new views (the preview switch on). Off by default: the day list stays the default. */
  preview: boolean;
  view: CalendarViewKind;
  /** Calendars toggled here: id to shown. Others follow Google's own tick. */
  shown: Record<string, boolean>;
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = { preview: false, view: 'week', shown: {} };

const MAX_TOGGLES = 100;

const VIEW = z.enum(CALENDAR_VIEWS as [CalendarViewKind, ...CalendarViewKind[]]);

const SHOWN = z
  .record(z.string().min(1).max(320), z.boolean())
  .refine((r) => Object.keys(r).length <= MAX_TOGGLES);

const STORED = z.object({
  preview: z.boolean().catch(false),
  view: VIEW.catch('week'),
  shown: SHOWN.catch({}),
});

export const CALENDAR_PREFS_PATCH = z
  .object({
    preview: z.boolean().optional(),
    view: VIEW.optional(),
    shown: z.record(z.string().min(1).max(320), z.boolean()).optional(),
  })
  .strict();

export type CalendarPrefsPatch = z.infer<typeof CALENDAR_PREFS_PATCH>;

export async function readCalendarPrefs(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<CalendarPrefs> {
  try {
    const rows = (await store.list(
      'audit_events',
      organizationId,
      { eq: { user_id: userId, action: CALENDAR_PREFS_ACTION } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    )) as AuditEvent[];
    const parsed = STORED.safeParse(rows[0]?.metadata ?? {});
    return parsed.success ? parsed.data : { ...DEFAULT_CALENDAR_PREFS };
  } catch (error) {
    log.warn('Calendar settings could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_CALENDAR_PREFS };
  }
}

/** Merge a change into the person's settings and keep it. Toggles beyond the cap drop the oldest. */
export async function saveCalendarPrefs(
  store: DataStore,
  organizationId: string,
  userId: string,
  patch: CalendarPrefsPatch,
  now: Date = new Date(),
): Promise<Result<CalendarPrefs>> {
  const current = await readCalendarPrefs(store, organizationId, userId);
  const shownEntries = Object.entries({ ...current.shown, ...(patch.shown ?? {}) });
  const next: CalendarPrefs = {
    preview: patch.preview ?? current.preview,
    view: patch.view ?? current.view,
    shown: Object.fromEntries(shownEntries.slice(-MAX_TOGGLES)),
  };
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: CALENDAR_PREFS_ACTION,
    entity_type: 'calendar',
    entity_id: null,
    metadata: { ...next },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  try {
    await store.insert('audit_events', row);
    return ok(next);
  } catch (error) {
    log.error('Calendar settings could not be saved', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('provider_unavailable', 'Your calendar settings could not be saved just now.', {
      stillUsable: 'The calendar works as before; this choice just is not remembered yet.',
      retryable: true,
    });
  }
}
