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
 * "New calendar" switch), which view they were last on, the calendars they
 * turned on or off, and the colour labels they filtered the views to. No schema change: an `audit_events` row per change
 * (action `calendar.prefs_set`, newest per person wins), written directly
 * rather than through recordAudit, whose redaction would mangle calendar ids
 * that look like email addresses. A failed read is the defaults, never an
 * error page.
 *
 * The new views are the default (D-069): someone who never chose gets them.
 * Rows written since carry `v: 2`, and their `preview` is the person's own
 * choice. Older rows always stored `preview`, false unless the switch was on,
 * so a false there is kept only when it was the switch that set it: a switch
 * turned from on to off, or a save that changed nothing else (the switch,
 * turned off on views opened by address). A false that came along with a
 * calendar toggle is not a choice, and reads as the new default.
 */

export const CALENDAR_PREFS_ACTION = 'calendar.prefs_set';
/** Rows written since the new views became the default. */
export const CALENDAR_PREFS_VERSION = 2;

export interface CalendarPrefs {
  /** On the new views (the switch on). On by default; off is the day list. */
  preview: boolean;
  view: CalendarViewKind;
  /** Calendars toggled here: id to shown. Others follow Google's own tick. */
  shown: Record<string, boolean>;
  /** The legend's label filter (label keys, lib/calendar/labels.ts); empty shows everything. */
  labelFilter: string[];
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  preview: true,
  view: 'week',
  shown: {},
  labelFilter: [],
};

const MAX_TOGGLES = 100;
const MAX_LABEL_FILTER = 50;
/** How far back an older "off" is traced to the switch that set it. */
const LEGACY_LOOKBACK = 50;

const VIEW = z.enum(CALENDAR_VIEWS as [CalendarViewKind, ...CalendarViewKind[]]);

const SHOWN = z
  .record(z.string().min(1).max(320), z.boolean())
  .refine((r) => Object.keys(r).length <= MAX_TOGGLES);

const LABEL_FILTER = z.array(z.string().min(1).max(200)).max(MAX_LABEL_FILTER);

const STORED = z.object({
  v: z.number().int().optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
  view: VIEW.catch('week'),
  shown: SHOWN.catch({}),
  labelFilter: LABEL_FILTER.catch([]),
});

type StoredPrefs = z.infer<typeof STORED>;

export const CALENDAR_PREFS_PATCH = z
  .object({
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

function parseRow(row: AuditEvent | undefined): StoredPrefs | null {
  if (!row) return null;
  const parsed = STORED.safeParse(row.metadata ?? {});
  return parsed.success ? parsed.data : null;
}

const sameShown = (a: Record<string, boolean>, b: Record<string, boolean>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] === a[k]);
};

/**
 * Whether an older row's "off" (newest first, rows[0] the off) was set by the
 * switch: it followed a row with the switch on, or changed nothing but the
 * save itself. A calendar toggle always changes `shown`, so it is never taken
 * for the switch. `complete` says the rows reach back to the person's first.
 */
export function legacySwitchedOff(rows: readonly StoredPrefs[], complete: boolean): boolean {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.v !== undefined) return row.preview === false;
    if (row.preview !== false) return false;
    const older = rows[i + 1];
    if (!older) return complete && Object.keys(row.shown).length === 0;
    if (older.v === undefined && older.preview === true) return true;
    if (sameShown(row.shown, older.shown) && row.view === older.view) return true;
  }
  return false;
}

export async function readCalendarPrefs(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<CalendarPrefs> {
  try {
    const latest = parseRow((await listRows(store, organizationId, userId, 1))[0]);
    if (!latest) return { ...DEFAULT_CALENDAR_PREFS };
    const settled = { view: latest.view, shown: latest.shown, labelFilter: latest.labelFilter };
    if (latest.v !== undefined || latest.preview !== false) {
      return { preview: latest.preview ?? true, ...settled };
    }
    // An older row saying the day list: kept only if the switch said so.
    const history = (await listRows(store, organizationId, userId, LEGACY_LOOKBACK))
      .map(parseRow)
      .filter((r): r is StoredPrefs => r !== null);
    const off = legacySwitchedOff(history, history.length < LEGACY_LOOKBACK);
    return { preview: !off, ...settled };
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
