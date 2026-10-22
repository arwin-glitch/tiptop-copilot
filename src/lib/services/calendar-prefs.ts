import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent } from '@/lib/types/domain';
import { log } from '@/lib/security/redact';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { CALENDAR_VIEWS, type CalendarViewKind } from '@/lib/calendar/range-types';

/**
 * Each person's Calendar tab settings: which view they were last on, the
 * calendars they turned on or off, and the colour labels they filtered the
 * views to. No schema change: an `audit_events` row per change (action
 * `calendar.prefs_set`, newest per person wins), written directly rather
 * than through recordAudit, whose redaction would mangle calendar ids that
 * look like email addresses. A failed read is the defaults, never an error
 * page.
 *
 * The "New calendar" switch and the day list it went back to are retired
 * (D-072): the views are the only way the tab shows. Older rows carry a
 * `preview` flag (the switch); it is ignored when read, and a save that still
 * names it (a page loaded before the change) is accepted and the flag
 * dropped. Rows written since carry `v: 3` and no flag.
 */

export const CALENDAR_PREFS_ACTION = 'calendar.prefs_set';
/** Rows written since the switch was retired (2: the views the default; 1 or none: before). */
export const CALENDAR_PREFS_VERSION = 3;

export interface CalendarPrefs {
  view: CalendarViewKind;
  /** Calendars toggled here: id to shown. Others follow Google's own tick. */
  shown: Record<string, boolean>;
  /** The legend's label filter (label keys, lib/calendar/labels.ts); empty shows everything. */
  labelFilter: string[];
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  view: 'week',
  shown: {},
  labelFilter: [],
};

const MAX_TOGGLES = 100;
const MAX_LABEL_FILTER = 50;

const VIEW = z.enum(CALENDAR_VIEWS as [CalendarViewKind, ...CalendarViewKind[]]);

const SHOWN = z
  .record(z.string().min(1).max(320), z.boolean())
  .refine((r) => Object.keys(r).length <= MAX_TOGGLES);

const LABEL_FILTER = z.array(z.string().min(1).max(200)).max(MAX_LABEL_FILTER);

/** A stored row: anything else on it (an older row's `preview`, its `v`) is left out. */
const STORED = z.object({
  view: VIEW.catch('week'),
  shown: SHOWN.catch({}),
  labelFilter: LABEL_FILTER.catch([]),
});

export const CALENDAR_PREFS_PATCH = z
  .object({
    /** The retired switch: still accepted from a page loaded before, and ignored. */
    preview: z.boolean().optional(),
    view: VIEW.optional(),
    shown: z.record(z.string().min(1).max(320), z.boolean()).optional(),
    labelFilter: LABEL_FILTER.optional(),
  })
  .strict();

export type CalendarPrefsPatch = z.infer<typeof CALENDAR_PREFS_PATCH>;

function listRows(store: DataStore, organizationId: string, userId: string, limit: number) {
  return store.list(
    'audit_events',
    organizationId,
    { eq: { user_id: userId, action: CALENDAR_PREFS_ACTION } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit },
  ) as Promise<AuditEvent[]>;
}

function parseRow(row: AuditEvent | undefined): CalendarPrefs | null {
  if (!row) return null;
  const parsed = STORED.safeParse(row.metadata ?? {});
  return parsed.success ? parsed.data : null;
}

export async function readCalendarPrefs(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<CalendarPrefs> {
  try {
    const latest = parseRow((await listRows(store, organizationId, userId, 1))[0]);
    return latest ?? { ...DEFAULT_CALENDAR_PREFS };
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
    view: patch.view ?? current.view,
    shown: Object.fromEntries(shownEntries.slice(-MAX_TOGGLES)),
    labelFilter: [...new Set(patch.labelFilter ?? current.labelFilter)].slice(0, MAX_LABEL_FILTER),
  };
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: CALENDAR_PREFS_ACTION,
    entity_type: 'calendar',
    entity_id: null,
    metadata: { v: CALENDAR_PREFS_VERSION, ...next },
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
